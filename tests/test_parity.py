"""JS<->Python decode parity on the golden five-day capture.

The webapp (webapp/codec.js + sync.js) and the offline decoder
(src/ido/captures.py) must turn the same watch bytes into the same records. A drift here is exactly how
the empty-marker bug slipped through: the phone saved a phantom sport day and
a "0-0-0" HR day while Python skipped both.
"""

import json
import subprocess
from pathlib import Path

from ido.captures import collect_health, load_lines

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "history-5day.jsonl"
EXPECTED = ROOT / "tests" / "fixtures" / "history-5day.expected.json"


def _js_decode() -> dict[str, list[dict[str, object]]]:
    out = subprocess.check_output(
        ["node", str(ROOT / "webapp" / "parity.test.js"), "--json", str(FIXTURE)],
        cwd=ROOT,
        text=True,
    )
    return json.loads(out)


def _python_decode() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    sport, _sleep, hr, _workouts = collect_health(load_lines(FIXTURE), FIXTURE.name)
    return sport, hr


def test_js_and_python_agree_on_sport_days() -> None:
    js = _js_decode()
    sport, _hr = _python_decode()

    assert len(js["steps"]) == len(sport) == 5
    for js_row, py_row in zip(js["steps"], sport, strict=True):
        assert js_row["date"] == py_row["date"]
        assert js_row["steps"] == py_row["total_steps"]
        assert js_row["distance_m"] == py_row["total_distance_m"]
        assert js_row["kcal"] == py_row["display_kcal"]
        assert js_row["active_min"] == py_row["total_active_min"]


def test_js_and_python_agree_on_hr_days() -> None:
    js = _js_decode()
    _sport, hr = _python_decode()

    assert len(js["hr"]) == len(hr) == 5
    for js_row, py_row in zip(js["hr"], hr, strict=True):
        assert js_row["date"] == py_row["date"]
        assert js_row["startS"] == py_row["start_time_s"]
        assert js_row["silent"] == py_row["silent_hr"]
        assert js_row["zones"] == [zone["thr"] for zone in py_row["zones"]]
        assert js_row["samples"] == [
            {"t": sample["t_s"], "bpm": sample["bpm"]} for sample in py_row["samples"]
        ]


def test_parity_fixture_has_no_phantom_records() -> None:
    js = _js_decode()
    dates = [
        row["date"]
        for group in ("steps", "hr", "spo2", "pressure")
        for row in js[group]
    ]
    assert "0-00-00" not in dates
    assert all(len(date) == 10 for date in dates)
    # Five completed days per type, no extra zero-filled terminal frame.
    assert {group: len(js[group]) for group in ("steps", "hr", "spo2", "pressure")} == {
        "steps": 5,
        "hr": 5,
        "spo2": 5,
        "pressure": 5,
    }


def test_golden_summary_matches_fixture() -> None:
    expected = json.loads(EXPECTED.read_text())
    js = _js_decode()
    assert [row["date"] for row in js["steps"]] == [
        row["date"] for row in expected["steps"]
    ]
    assert [row["steps"] for row in js["steps"]] == [
        row["steps"] for row in expected["steps"]
    ]
    assert [row["date"] for row in js["hr"]] == [row["date"] for row in expected["hr"]]
    assert [len(row["samples"]) for row in js["hr"]] == [
        row["sample_count"] for row in expected["hr"]
    ]
