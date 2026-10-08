"""Tests for sync.py export/merge rules (steps precedence, sleep dedupe)."""

from sync import export_sleep, export_steps


def _live(ts: str, steps: int, distance_m: int) -> dict[str, object]:
    return {
        "ts": ts,
        "steps": steps,
        "distance_m": distance_m,
        "source": "test",
    }


def _sport(date: str, steps: int) -> dict[str, object]:
    return {
        "date": date,
        "total_steps": steps,
        "total_distance_m": steps,
        "display_kcal": 100,
        "total_active_min": 10,
        "source": "test",
    }


def _night(fall: tuple[int, int, int, int, int], total_min: int) -> dict[str, object]:
    (year, month, day, hour, minute) = fall
    return {
        "fall_asleep_year": year,
        "fall_asleep_month": month,
        "fall_asleep_day": day,
        "fall_asleep_hour": hour,
        "fall_asleep_min": minute,
        "get_up_year": year,
        "get_up_month": month,
        "get_up_day": day,
        "get_up_hour": 6,
        "get_up_min": 52,
        "total_min": total_min,
        "wake_min": 0,
        "light_min": total_min,
        "rem_min": 0,
        "deep_min": 0,
        "source": "test",
    }


def test_export_steps_sport_beats_live() -> None:
    rows = export_steps(
        [_sport("2026-10-08", 5000)],
        [_live("2026-10-08T10:00:00Z", 100, 70)],
    )
    assert len(rows) == 1
    assert rows[0]["steps"] == 5000
    assert rows[0]["kcal"] == 100
    assert "type08" in str(rows[0]["source"])


def test_export_steps_latest_live_wins_without_sport() -> None:
    rows = export_steps(
        [],
        [
            _live("2026-10-08T10:00:00Z", 100, 70),
            _live("2026-10-08T18:00:00Z", 300, 210),
        ],
    )
    assert len(rows) == 1
    assert rows[0]["steps"] == 300
    assert rows[0]["kcal"] == ""


def test_export_steps_empty() -> None:
    assert export_steps([], []) == []


def test_export_sleep_dedupes_same_night() -> None:
    nights = export_sleep(
        [
            _night((2026, 10, 1, 23, 47), 425),
            _night((2026, 10, 1, 23, 47), 425),
            _night((2026, 10, 2, 23, 43), 438),
        ]
    )
    assert [n["night"] for n in nights] == ["2026-10-01", "2026-10-02"]
    assert nights[0]["fall_asleep"] == "2026-10-01 23:47"
    assert nights[0]["total_min"] == 425
