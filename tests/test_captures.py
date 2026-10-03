"""Tests for offline capture helpers (JSONL load + v3 reassembly)."""

from ido.captures import collect_health, collect_live, reassemble_frames


def _chunk(logical: bytes, start: int, end: int) -> bytes:
    return bytes((0x33,)) + logical[start:end]


def _frame_bytes(cmd: int, seq: int, payload: bytes) -> bytes:
    logical = (
        bytes((0xDA, 0xAD, 0xDA, 0xAD, 0x01))
        + (len(payload) + 11).to_bytes(2, "little")
        + cmd.to_bytes(2, "little")
        + seq.to_bytes(2, "little")
        + payload
    )
    assert logical[5] | (logical[6] << 8) == len(logical)
    return logical


def test_reassemble_single_chunk_frame() -> None:
    logical = _frame_bytes(0x0004, 0x61, bytes(14))
    assert reassemble_frames([bytes((0x33,)) + logical]) == [logical]


def test_reassemble_multi_chunk_frame() -> None:
    logical = _frame_bytes(0x0004, 0x61, bytes(range(60)))
    chunks = [_chunk(logical, 0, 12), _chunk(logical, 12, 40), _chunk(logical, 40, 71)]
    assert reassemble_frames(chunks) == [logical]


def test_reassemble_two_frames_back_to_back() -> None:
    first = _frame_bytes(0x0004, 0x61, bytes(10))
    second = _frame_bytes(0x0004, 0x62, bytes(10))
    chunks = [bytes((0x33,)) + first, bytes((0x33,)) + second]
    assert reassemble_frames(chunks) == [first, second]


def test_reassemble_ignores_non_v3() -> None:
    assert reassemble_frames([bytes.fromhex("02A05127")]) == []


def test_collect_live_picks_snapshots() -> None:
    lines = [
        {"ts": "t1", "char": "0x0AF6", "dir": "TX", "hex": "02A0"},
        {
            "ts": "t2",
            "char": "0x0AF7",
            "dir": "RX",
            "hex": "02A05127000086070000D91D00001E000000F0",
        },
    ]
    rows = collect_live(lines)
    assert len(rows) == 1
    assert rows[0]["steps"] == 10065
    assert rows[0]["distance_m"] == 7641


def test_collect_health_skips_empty_marker() -> None:
    payload = bytes((0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x28, 0x00)) + bytes(45)
    logical = _frame_bytes(0x0004, 0x60, payload)
    lines = [
        {
            "ts": "t",
            "char": "0x0AF7",
            "dir": "RX",
            "hex": (bytes((0x33,)) + logical).hex(),
        }
    ]
    sport, sleep = collect_health(lines, "test")
    assert sport == [] and sleep == []
