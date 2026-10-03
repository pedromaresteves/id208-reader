"""IDO/VeryFit 0x0AF0 protocol constants and decoders.

Confirmed on ID208 Plus via nRF Connect (Phase 0 Test A):
service 0x0AF0, chars 0x0AF6/0x0AF7/0x0AF1/0x0AF2.
"""

SERVICE_UUID = 0x0AF0
CHAR_WRITE = 0x0AF6  # READ, WRITE, WRITE NO RESPONSE
CHAR_NOTIFY = 0x0AF7  # NOTIFY, READ
CHAR_HEALTH_WRITE = 0x0AF1  # READ, WRITE, WRITE NO RESPONSE
CHAR_HEALTH_NOTIFY = 0x0AF2  # NOTIFY, READ

CMD_GET_INFO = bytes((0x02, 0x01))
CMD_GET_LIVE = bytes((0x02, 0xA0))

# v3 health (0x0AF1 write -> 0x0AF2 notify). Layout from
# d3nd3/toobur-veryfit-research LATEST_SYNC_PARSING.md + logcat sync_example.txt.
V3_PREAMBLE = bytes((0x33, 0xDA, 0xAD, 0xDA, 0xAD))
V3_CMD_SIZES = 0x0005
V3_CMD_SYNC = 0x0004
V3_DATA_TYPES = (0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x08)
# byte14: 0x01 day-data (01,02,03,08), 0x00 count-data (04,06,07).
V3_BYTE14 = {1: 1, 2: 1, 3: 1, 4: 0, 6: 0, 7: 0, 8: 1}


def parse_basic_info(payload: bytes) -> dict[str, int]:
    """Parse a `02 01` basic-info reply.

    Layout from xssfox/idowatch htmlapp (offsets after header):
    device_id[2:2], firmware[4:1], mode[5:1], batt[6:1], ...
    Raises ValueError on too-short / wrong-header payloads.
    """
    if len(payload) < 2:
        raise ValueError("payload too short")
    if payload[0] != 0x02 or payload[1] != 0x01:
        raise ValueError(f"not a basic-info reply: {payload[:2].hex()}")
    data = payload[2:]

    def u8(i: int) -> int:
        return data[i] if i < len(data) else 0

    def u16le(i: int) -> int:
        if i + 1 >= len(data):
            return 0
        return data[i] | (data[i + 1] << 8)

    return {
        "device_id": u16le(0),
        "firmware_version": u8(2),
        "mode": u8(3),
        "batt_status": u8(4),
        "energy": u8(5),
        "pair": u8(6),
    }


def parse_live_data(payload: bytes) -> dict[str, int]:
    """Parse a `02 A0` live-data reply (19 bytes observed).

    Ground truth anchors 2026-10-03:
    - 17:17 watch 10065 steps / 7.64 km -> steps 10065, distance_m 7641
    - 16:47 watch 10004 steps / 7.6 km -> steps 10004, distance_m 7595
    Field mapping vs v3 sport summary (same values, same order):
    unknown_u32_1 mirrors the sport raw field (1926, unit unknown, NOT kcal),
    unknown_u32_2 mirrors active minutes (30 = met 30-min goal).
    Display kcal lives only in the sport header ([26:28] = 631).
    Raises ValueError on too-short / wrong-header payloads.
    """
    if len(payload) < 18:
        raise ValueError("live-data payload too short")
    if payload[0] != 0x02 or payload[1] != 0xA0:
        raise ValueError(f"not a live-data reply: {payload[:2].hex()}")
    out = {
        "steps": int.from_bytes(payload[2:6], "little"),
        "unknown_u32_1": int.from_bytes(payload[6:10], "little"),
        "distance_m": int.from_bytes(payload[10:14], "little"),
        "unknown_u32_2": int.from_bytes(payload[14:18], "little"),
    }
    if len(payload) >= 19:
        out["tail"] = payload[18]
    return out


def crc16_ccitt(data: bytes) -> int:
    """CRC-16-CCITT-FALSE (poly 0x1021, init 0xFFFF) for v3 packets."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = (
                ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
            )
    return crc


def _finish_v3(packet: bytearray) -> bytes:
    crc = crc16_ccitt(bytes(packet[1 : len(packet) - 2]))
    packet[len(packet) - 2] = crc & 0xFF
    packet[len(packet) - 1] = (crc >> 8) & 0xFF
    return bytes(packet)


def build_v3_sizes_05(seq: int) -> bytes:
    """Build a 137-byte v3 cmd 0x05 health-sizes query (all types, offset 0)."""
    pkt = bytearray(137)
    pkt[0:5] = V3_PREAMBLE
    pkt[5] = 0x01
    pkt[6:8] = (0x0088).to_bytes(2, "little")
    pkt[8:10] = V3_CMD_SIZES.to_bytes(2, "little")
    pkt[10:12] = (seq & 0xFFFF).to_bytes(2, "little")
    off = 12
    for data_type in V3_DATA_TYPES:
        pkt[off] = data_type
        off += 5  # type + 4-byte LE offset 0
    return _finish_v3(pkt)


def build_v3_start_04(data_type: int, seq: int, save_offset: int = 0) -> bytes:
    """Build a 19-byte v3 cmd 0x04 START for one health data_type.

    save_offset (bytes 15-16 LE) is the resume position in that type's
    stored stream: 0 = oldest record. Paging example: sleep START with
    offset 0 returned the Sep-28 night; larger offsets should return
    newer nights (exact granularity TBD on-watch: try 1, item counts,
    then byte sizes like 54 / 94 / 108).
    """
    if data_type not in V3_BYTE14:
        raise ValueError(f"unknown v3 data_type: {data_type:#x}")
    pkt = bytearray(19)
    pkt[0:5] = V3_PREAMBLE
    pkt[5] = 0x01
    pkt[6:8] = (0x0010).to_bytes(2, "little")
    pkt[8:10] = V3_CMD_SYNC.to_bytes(2, "little")
    pkt[10:12] = (seq & 0xFFFF).to_bytes(2, "little")
    pkt[12] = 0x00  # operate START
    pkt[13] = data_type
    pkt[14] = V3_BYTE14[data_type]
    pkt[15:17] = (save_offset & 0xFFFF).to_bytes(2, "little")
    return _finish_v3(pkt)


def parse_v3_health_common(payload: bytes) -> dict[str, int]:
    """Parse the 14-byte health common header at the start of a 0x04 payload."""
    if len(payload) < 14:
        raise ValueError("v3 health payload too short")
    return {
        "operate": payload[0],
        "data_type": payload[1],
        "item_count": int.from_bytes(payload[5:7], "little"),
        "head_size": int.from_bytes(payload[7:9], "little"),
        "data_size": int.from_bytes(payload[9:13], "little"),
    }


def parse_sport_summary(header: bytes) -> dict[str, int]:
    """Parse a dataType 0x08 sport header (>= 20 bytes).

    Ground truth anchors:
    - 2026-10-01: total_steps 5736.
    - 2026-10-03 17:17: steps 10065, distance 7641 m, display kcal 631,
      active 30 min (watch showed 10065 steps / 7.64 km / 631 kcal).
    Note: bytes [12:16] are NOT display kcal (1926 vs 631 on screen) —
    unit unknown, kept as raw_total_calories. Display kcal is u16 at [26:28].
    Bytes [20:24] behave as active minutes (30), not seconds.
    """
    if len(header) < 20:
        raise ValueError("sport header too short")
    out = {
        "total_steps": int.from_bytes(header[8:12], "little"),
        "raw_total_calories": int.from_bytes(header[12:16], "little"),
        "total_distance_m": int.from_bytes(header[16:20], "little"),
    }
    if len(header) >= 24:
        out["total_active_min"] = int.from_bytes(header[20:24], "little")
    if len(header) >= 28:
        out["display_kcal"] = int.from_bytes(header[26:28], "little")
    return out


def parse_sleep_summary(header: bytes) -> dict[str, int]:
    """Parse a dataType 0x07 sleep header (>= 16 bytes).

    Ground truth anchors:
    - 2026-10-01: total 425 min, 23:47 -> 06:52.
    - 2026-10-03 capture (night of Sep 28): fall asleep 2026-09-28 23:41,
      get up 2026-09-29 07:06, total 445 min (wake 21, light 215,
      REM 136, deep 73; sums to 445).
    """
    if len(header) < 16:
        raise ValueError("sleep header too short")

    def u16(i: int) -> int:
        return (
            int.from_bytes(header[i : i + 2], "little") if i + 2 <= len(header) else 0
        )

    return {
        "fall_asleep_year": u16(2),
        "fall_asleep_month": header[4],
        "fall_asleep_day": header[5],
        "fall_asleep_hour": header[6],
        "fall_asleep_min": header[7],
        "get_up_year": u16(8),
        "get_up_month": header[10],
        "get_up_day": header[11],
        "get_up_hour": header[12],
        "get_up_min": header[13],
        "total_min": u16(14),
        "wake_min": u16(16),
        "light_min": u16(18),
        "rem_min": u16(20),
        "deep_min": u16(22),
    }
