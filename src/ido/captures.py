"""Offline capture helpers: load phone JSONL, reassemble v3 frames, extract records.

Phone captures (phase0/health.html Download JSONL) hold one frame per line:
{"ts": ..., "char": "0x0AF7", "dir": "RX"|"TX", "hex": ...}.
Legacy replies (02 01 / 02 A0) arrive whole; v3 health replies (33 DA AD DA AD...)
may span several notifications: first chunk carries the total length at
bytes [6:8], continuation chunks are 0x33 + payload only.
"""

import json
from pathlib import Path

from ido.decoder import (
    parse_hr_day,
    parse_live_data,
    parse_sleep_summary,
    parse_sport_summary,
    parse_v3_health_common,
    parse_workout_summary,
)

V3_PREAMBLE = bytes((0x33, 0xDA, 0xAD, 0xDA, 0xAD))


def load_lines(path: Path) -> list[dict[str, str]]:
    """Load one JSONL capture file (TX and RX lines, hex + timestamp)."""
    lines = []
    with path.open() as fh:
        for raw in fh:
            raw = raw.strip()
            if raw:
                lines.append(json.loads(raw))
    return lines


def reassemble_frames(chunks: list[bytes]) -> list[bytes]:
    """Reassemble v3 notification chunks into logical frames.

    Each chunk starts with 0x33; the first chunk of a frame also carries
    the DA AD DA AD preamble and the total length at bytes [6:8].
    Returns logical frames with the per-chunk 0x33 prefix stripped
    (so frames start with DA AD DA AD).
    """
    frames: list[bytes] = []
    buf: bytearray | None = None
    total = 0
    for chunk in chunks:
        if not chunk or chunk[0] != 0x33:
            continue
        if len(chunk) >= 10 and chunk[1:5] == V3_PREAMBLE[1:]:
            total = chunk[6] | (chunk[7] << 8)
            if total <= 0 or total > 8192:
                buf = None
                continue
            buf = bytearray(chunk[1:])
        elif buf is not None:
            buf.extend(chunk[1:])
        else:
            continue
        if buf is not None and len(buf) >= total:
            frames.append(bytes(buf[:total]))
            buf = None
    return frames


def split_frame(frame: bytes) -> tuple[int, int, bytes]:
    """Split a logical v3 frame into (cmd, seq, payload)."""
    cmd = frame[7] | (frame[8] << 8)
    seq = frame[9] | (frame[10] << 8)
    return cmd, seq, bytes(frame[11:])


def collect_live(lines: list[dict[str, str]]) -> list[dict[str, object]]:
    """Collect 02 A0 live snapshots (steps/distance) from RX lines."""
    out = []
    for line in lines:
        if line.get("dir") != "RX":
            continue
        raw = bytes.fromhex(line["hex"])
        if len(raw) >= 18 and raw[0] == 0x02 and raw[1] == 0xA0:
            parsed = parse_live_data(raw)
            out.append({"ts": line.get("ts", ""), **parsed})
    return out


def collect_health(
    lines: list[dict[str, str]], source: str
) -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
]:
    """Collect v3 sport summaries, sleep nights, HR days and raw workouts.

    Groups consecutive RX chunks starting with 0x33 on the same
    characteristic into frames; skips empty end-of-history markers
    (item_count == 0) and STOP acks (no header).
    Returns (sport_rows, sleep_rows, hr_rows, workout_rows); workout rows
    carry the decoded summary plus head_hex (segment tables stay in the
    source JSONL until a run anchors their layout).
    """
    sport_rows: list[dict[str, object]] = []
    sleep_rows: list[dict[str, object]] = []
    hr_rows: list[dict[str, object]] = []
    workout_rows: list[dict[str, object]] = []
    pending: list[bytes] = []
    pending_char = ""

    def flush() -> None:
        for frame in reassemble_frames(pending):
            cmd, _seq, payload = split_frame(frame)
            if cmd != 0x0004 or len(payload) < 14:
                continue
            try:
                common = parse_v3_health_common(payload)
            except ValueError:
                continue
            if common["item_count"] == 0:
                continue  # end-of-history marker / STOP ack
            head = payload[14 : 14 + common["head_size"]]
            if len(head) < common["head_size"]:
                continue
            data = payload[14 + common["head_size"] :]
            if common["data_type"] == 0x08 and len(head) >= 20:
                summary = parse_sport_summary(head)
                year = int.from_bytes(head[1:3], "little")
                sport_rows.append(
                    {
                        "date": f"{year:04d}-{head[3]:02d}-{head[4]:02d}",
                        **summary,
                        "source": source,
                    }
                )
            elif common["data_type"] == 0x07 and len(head) >= 16:
                summary = parse_sleep_summary(head)
                sleep_rows.append({**summary, "source": source})
            elif common["data_type"] == 0x03 and len(head) >= 10:
                summary = parse_hr_day(head, data, common["item_count"])
                hr_rows.append(
                    {
                        "date": (
                            f"{summary['year']:04d}-{summary['month']:02d}-"
                            f"{summary['day']:02d}"
                        ),
                        **summary,
                        "source": source,
                    }
                )
            elif common["data_type"] == 0x04 and len(head) >= 100:
                summary = parse_workout_summary(head, data)
                workout_rows.append(
                    {
                        "date": (
                            f"{summary['year']:04d}-{summary['month']:02d}-"
                            f"{summary['day']:02d}"
                        ),
                        **summary,
                        "head_hex": head.hex(),
                        "source": source,
                    }
                )

    for line in lines:
        if line.get("dir") != "RX":
            continue
        raw = bytes.fromhex(line["hex"])
        if not raw or raw[0] != 0x33:
            continue
        if pending and line.get("char") != pending_char:
            flush()
            pending = []
        pending_char = str(line.get("char"))
        pending.append(raw)
    if pending:
        flush()
    return sport_rows, sleep_rows, hr_rows, workout_rows
