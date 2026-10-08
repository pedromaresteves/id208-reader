"""Local sync entry point: decode phone captures -> out/steps.csv + more.

No network, no account. Flow: try a BLE scan (skips cleanly on WSL with
no adapter), then decode captures/*.jsonl offline with src/ido/captures.py.
Steps prefer v3 sport summaries; nights without one fall back to the latest
02 A0 live snapshot of that day. Also exports sleep, HR days and workouts.
"""

import asyncio
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from ido.captures import collect_health, collect_live, load_lines

CAPTURES_DIR = ROOT / "captures"
OUT_DIR = ROOT / "out"


def _day(ts: str) -> str:
    return ts[:10] if len(ts) >= 10 else ""


def export_steps(
    sport_rows: list[dict[str, object]], live_rows: list[dict[str, object]]
) -> list[dict[str, object]]:
    """One best row per date: v3 sport summary wins, else latest live snapshot."""
    best: dict[str, dict[str, object]] = {}
    for row in live_rows:
        day = _day(str(row.get("ts", "")))
        if not day:
            continue
        prev = best.get(day)
        if prev is None or str(row.get("ts", "")) > str(prev.get("ts", "")):
            best[day] = {
                "date": day,
                "steps": row["steps"],
                "distance_m": row["distance_m"],
                "kcal": "",
                "active_min": "",
                "source": f"live 02A0 {row.get('ts', '')} {row.get('source', '')}",
            }
    for row in sport_rows:
        best[str(row["date"])] = {
            "date": row["date"],
            "steps": row["total_steps"],
            "distance_m": row["total_distance_m"],
            "kcal": row.get("display_kcal", ""),
            "active_min": row.get("total_active_min", ""),
            "source": f"v3 sport type08 {row.get('source', '')}",
        }
    return [best[day] for day in sorted(best)]


def export_sleep(sleep_rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """Dedupe nights by fall-asleep date, oldest first."""

    def key(row: dict[str, object]) -> tuple[object, ...]:
        return (
            row.get("fall_asleep_year"),
            row.get("fall_asleep_month"),
            row.get("fall_asleep_day"),
            row.get("fall_asleep_hour"),
            row.get("fall_asleep_min"),
        )

    seen: dict[tuple[object, ...], dict[str, object]] = {}
    for row in sleep_rows:
        seen.setdefault(key(row), row)
    ordered = [seen[k] for k in sorted(seen)]
    out = []
    for row in ordered:
        fall = (
            f"{row['fall_asleep_year']:04d}-{row['fall_asleep_month']:02d}-"
            f"{row['fall_asleep_day']:02d} "
            f"{row['fall_asleep_hour']:02d}:{row['fall_asleep_min']:02d}"
        )
        up = (
            f"{row['get_up_year']:04d}-{row['get_up_month']:02d}-"
            f"{row['get_up_day']:02d} "
            f"{row['get_up_hour']:02d}:{row['get_up_min']:02d}"
        )
        out.append(
            {
                "night": fall[:10],
                "fall_asleep": fall,
                "get_up": up,
                "total_min": row["total_min"],
                "wake_min": row["wake_min"],
                "light_min": row["light_min"],
                "rem_min": row["rem_min"],
                "deep_min": row["deep_min"],
                "source": row.get("source", ""),
            }
        )
    return out


async def _main() -> int:
    try:
        from bleak import BleakScanner

        found = await BleakScanner.discover(timeout=5.0)
        names = sorted({(d.name or "?") for d in found})
        print(f"BLE scan ok, {len(found)} device(s) nearby: {', '.join(names[:10])}")
    except Exception as exc:  # noqa: BLE001 - any adapter/DBus failure means "no BLE here"
        print(f"BLE scan skipped ({exc})", file=sys.stderr)

    sport_rows: list[dict[str, object]] = []
    live_rows: list[dict[str, object]] = []
    sleep_rows: list[dict[str, object]] = []
    hr_rows: list[dict[str, object]] = []
    workout_rows: list[dict[str, object]] = []
    for path in sorted(CAPTURES_DIR.glob("*.jsonl")):
        lines = load_lines(path)
        for row in collect_live(lines):
            row["source"] = path.name
            live_rows.append(row)
        sport, sleep, hr, workouts = collect_health(lines, path.name)
        sport_rows.extend(sport)
        sleep_rows.extend(sleep)
        hr_rows.extend(hr)
        workout_rows.extend(workouts)
    print(
        f"decoded {len(sport_rows)} sport, {len(live_rows)} live, "
        f"{len(sleep_rows)} sleep, {len(hr_rows)} hr, "
        f"{len(workout_rows)} workout rows"
    )

    OUT_DIR.mkdir(exist_ok=True)
    steps = export_steps(sport_rows, live_rows)
    steps_csv = OUT_DIR / "steps.csv"
    with steps_csv.open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=["date", "steps", "distance_m", "kcal", "active_min", "source"],
        )
        writer.writeheader()
        writer.writerows(steps)
    print(f"wrote {steps_csv} ({len(steps)} days)")

    nights = export_sleep(sleep_rows)
    sleep_json = OUT_DIR / "sleep.json"
    sleep_json.write_text(json.dumps(nights, indent=2) + "\n")
    print(f"wrote {sleep_json} ({len(nights)} nights)")

    hr_json = OUT_DIR / "hr.json"
    hr_json.write_text(json.dumps(hr_rows, indent=2) + "\n")
    print(f"wrote {hr_json} ({len(hr_rows)} days)")

    workout_json = OUT_DIR / "workouts.json"
    workout_json.write_text(json.dumps(workout_rows, indent=2) + "\n")
    print(f"wrote {workout_json} ({len(workout_rows)} records)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
