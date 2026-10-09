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

# Bind / setup (0x0AF6 write -> 0x0AF7 notify, no account needed).
# BIND_START confirmed live on A200 (22/23 OK, bind-v3.json):
# TX 04 01 F1 01 01 02 02 01 00 -> RX 04 01 00 00. Unbind mirrors key 0x02.
CMD_BIND_START = bytes((0x04, 0x01, 0xF1, 0x01, 0x01, 0x02, 0x02, 0x01, 0x00))
CMD_BIND_STOP = bytes((0x04, 0x02, 0xF1, 0x01, 0x01, 0x02, 0x02, 0x01, 0x00))
# BIND AUTH (key 0x03, VBUS evt 202) + ENCRYPTED AUTH (key 0x05, evt 204).
# Solved 2026-10-08 from instrumented VeryFit bind
# (captures/veryfit-bind-2026-10-08.log #26-32) plus the reset-test failure:
# after `04 01`, VeryFit sends `03 23 02 00`, then
# `04 05 0C 00 + challenge[6] + (challenge XOR watchMAC)[6]`.
# challenge = trailing 6 bytes of the `04 01` reply (watch clock:
# year_low, mon, day, hh, mm, sec). Verified on TWO independent samples:
# Oct 8 success (EA..3B ^ F4..45 = 1E..7E) and the stale 18:23 attempt
# (D0..0B ^ F4..45 = 24..4E) — the latter failed with `04 05 02 00`
# only because its challenge was stale. Reply `04 05 00 00` finalizes
# the bind (`pair` flips 0 -> 1). Random trailing bytes are REJECTED.
CMD_BIND_AUTH = bytes((0x04, 0x03))
CMD_SET_23_SAMPLE = bytes((0x03, 0x23, 0x02, 0x00))
# SET time sample from VeryFit logcat (2026-03-08 01:17:24):
# 03 01 EA 07 03 08 01 11 18 06 00 * 6.
CMD_SET_TIME_PREFIX = bytes((0x03, 0x01))
# SET user-info sample from VeryFit fresh-launch (10 B total, payload TBD):
# 03 10 B4 40 1F 00 D6 07 03 01. Any valid packet clears the setup gate.
CMD_SET_USER_INFO_SAMPLE = bytes(
    (0x03, 0x10, 0xB4, 0x40, 0x1F, 0x00, 0xD6, 0x07, 0x03, 0x01)
)
# Post-bind prelude samples from VeryFit fresh-launch logcat (app_fresh_launch).
# VeryFit sends these after BIND before the watch leaves its setup screen:
# units (17 B), calorie+distance goals (20 B), weather switch off (6 B).
CMD_SET_UNITS_SAMPLE = bytes.fromhex("0311010101000201000000010101010000")
# Units variant from the reinstall-bind log (byte[7] 0x02 vs 0x01 above).
CMD_SET_UNITS_BIND = bytes.fromhex("0311010101000202000000010101010000")
CMD_SET_GOALS_SAMPLE = bytes.fromhex("0343F40100000000000008070000FA000E060C00")
CMD_SET_WEATHER_OFF = bytes.fromhex("032D55000000")
# Auto activity/sport detection (SET 03 49, VBUS_EVT_APP_SET_ACTIVITY_SWITCH).
# 11 bytes: 9 flag bytes after the header, in order: walk, run, bicycle,
# auto_pause, auto_end_remind, elliptical, rowing, swim, smart_rope (0/1).
# Captured in the Gadgetbridge-veryfit fork (TooburAutoActivitySwitchPackets):
# all-off silences the "long walk?" prompt.
CMD_AUTO_ACTIVITY_FLAGS = (
    "walk",
    "run",
    "bicycle",
    "auto_pause",
    "auto_end_remind",
    "elliptical",
    "rowing",
    "swim",
    "smart_rope",
)
# v3 HR-mode payload transplanted from reinstall-bind logcat (12 bytes after
# seq). Only seq + CRC are refreshed per send; stale schedule bytes tolerated.
HR_MODE_PAYLOAD = bytes.fromhex("0000000000010000173B0000")

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
    Extended flags (bind_confirm_flag, show_bind_choice, ...) share the
    same table so a fresh reset (unbound, QR screen) is distinguishable
    from a bound watch. Missing bytes default to 0.
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
        "reboot": u8(7),
        "bind_confirm_flag": u8(9),
        "platform": u8(10),
        "shape": u8(11),
        "dev_type": u8(12),
        "show_bind_choice": u8(15),
        "gps_platform": u8(17),
    }


def parse_bind_reply(payload: bytes) -> dict[str, int]:
    """Parse a `04 01` / `04 02` / `04 03` / `04 05` bind reply.

    Known shapes: `04 01 00 0C 00 + MAC[6] + challenge[6]`,
    `04 05 00 00 ...` (status 0 = auth accepted, `02` = rejected).
    """
    if len(payload) < 3:
        raise ValueError("bind reply too short")
    if payload[0] != 0x04 or payload[1] not in (0x01, 0x02, 0x03, 0x05):
        raise ValueError(f"not a bind reply: {payload[:2].hex()}")
    out = {"key": payload[1], "status": payload[2]}
    if len(payload) > 3:
        out["detail"] = payload[3]
    return out


def parse_bind_challenge(payload: bytes) -> bytes:
    """Extract the 6-byte auth challenge from a `04 01` bind reply.

    Layout: `04 01 00 0C 00 + MAC[6] + challenge[6]` (17 bytes); the challenge
    is the watch clock (year_low, month, day, hour, min, sec).
    Raises ValueError on wrong shape.
    """
    if len(payload) < 17 or payload[0] != 0x04 or payload[1] != 0x01:
        raise ValueError(f"not a bind challenge reply: {payload[:4].hex()}")
    return bytes(payload[11:17])


def parse_bind_mac(payload: bytes) -> bytes:
    """Extract the 6-byte watch MAC from a `04 01` bind reply (bytes 5-10)."""
    if len(payload) < 17 or payload[0] != 0x04 or payload[1] != 0x01:
        raise ValueError(f"not a bind challenge reply: {payload[:4].hex()}")
    return bytes(payload[5:11])


def build_bind_auth_probe() -> bytes:
    """Return the bare 2-byte `04 03` auth probe (watch stays silent)."""
    return bytes(CMD_BIND_AUTH)


def build_bind_auth(challenge: bytes, mac: bytes) -> bytes:
    """Build the 16-byte `04 05` encrypted-auth packet that finalizes binding.

    `challenge`: 6 bytes from the `04 01` reply (see parse_bind_challenge);
    `mac`: 6-byte watch MAC from the same reply (see parse_bind_mac).
    Trailing 6 bytes = challenge XOR mac (proven on two samples).
    Verified byte-identical against the instrumented VeryFit bind.
    """
    if len(challenge) != 6 or len(mac) != 6:
        raise ValueError("challenge and mac must be 6 bytes each")
    sealed = bytes(c ^ m for c, m in zip(bytes(challenge), bytes(mac)))
    return bytes((0x04, 0x05, 0x0C, 0x00)) + bytes(challenge) + sealed


def build_set_23_sample() -> bytes:
    """Return the 4-byte `03 23 02 00` VeryFit sends between bind and auth."""
    return bytes(CMD_SET_23_SAMPLE)


def build_bind_start() -> bytes:
    """Return the 9-byte VeryFit-style BIND START (clears QR setup, no account)."""
    return bytes(CMD_BIND_START)


def build_bind_stop() -> bytes:
    """Return the 9-byte unbind packet (key 0x02, same trailer)."""
    return bytes(CMD_BIND_STOP)


def build_set_time(
    year: int,
    month: int,
    day: int,
    hour: int,
    minute: int,
    second: int,
    weekday: int,
) -> bytes:
    """Build a 16-byte SET time packet (03 01 + 14-byte payload).

    Layout from VeryFit logcat set_time.txt: year LE u16, month, day,
    hour, minute, second, weekday, then 6 zero bytes.
    """
    payload = (
        bytes((0x03, 0x01))
        + int(year).to_bytes(2, "little")
        + bytes(
            (
                month & 0xFF,
                day & 0xFF,
                hour & 0xFF,
                minute & 0xFF,
                second & 0xFF,
                weekday & 0xFF,
                0,
                0,
                0,
                0,
                0,
                0,
            )
        )
    )
    assert len(payload) == 16
    return payload


def build_user_info_sample() -> bytes:
    """Return the 10-byte VeryFit user-info sample (payload TBD, clears setup)."""
    return bytes(CMD_SET_USER_INFO_SAMPLE)


def build_units_sample() -> bytes:
    """Return the 17-byte VeryFit units sample from fresh-launch logcat."""
    return bytes(CMD_SET_UNITS_SAMPLE)


def build_units_bind() -> bytes:
    """Return the 17-byte units variant from the reinstall-bind log."""
    return bytes(CMD_SET_UNITS_BIND)


def build_goals_sample() -> bytes:
    """Return the 20-byte VeryFit calorie+distance goals sample."""
    return bytes(CMD_SET_GOALS_SAMPLE)


def build_weather_off() -> bytes:
    """Return the 6-byte weather-switch-off packet from fresh-launch logcat."""
    return bytes(CMD_SET_WEATHER_OFF)


def build_auto_activity(
    *,
    walk: bool = False,
    run: bool = False,
    bicycle: bool = False,
    auto_pause: bool = False,
    auto_end_remind: bool = False,
    elliptical: bool = False,
    rowing: bool = False,
    swim: bool = False,
    smart_rope: bool = False,
) -> bytes:
    """Build the 11-byte `03 49` auto activity/sport detection packet.

    All flags default off (silences the "long walk?" prompt); pass any
    combination to re-enable. Flag order follows CMD_AUTO_ACTIVITY_FLAGS.
    """
    flags = bytes(
        (
            0x01 if walk else 0x00,
            0x01 if run else 0x00,
            0x01 if bicycle else 0x00,
            0x01 if auto_pause else 0x00,
            0x01 if auto_end_remind else 0x00,
            0x01 if elliptical else 0x00,
            0x01 if rowing else 0x00,
            0x01 if swim else 0x00,
            0x01 if smart_rope else 0x00,
        )
    )
    return bytes((0x03, 0x49)) + flags


def build_v3_1a(seq: int) -> bytes:
    """Build a 14-byte v3 cmd 0x1A func-table query (VeryFit sends it on connect)."""
    pkt = bytearray(14)
    pkt[0:5] = V3_PREAMBLE
    pkt[5] = 0x01
    pkt[6:8] = (0x000B).to_bytes(2, "little")
    pkt[8:10] = (0x001A).to_bytes(2, "little")
    pkt[10:12] = (seq & 0xFFFF).to_bytes(2, "little")
    return _finish_v3(pkt)


def build_hr_mode(seq: int) -> bytes:
    """Build a 26-byte v3 cmd 0x09 HR-mode packet (reinstall-bind sequence).

    Payload transplanted verbatim from the reinstall-bind logcat; only the
    sequence number is refreshed and the CRC recomputed. Goes on 0x0AF6.
    """
    pkt = bytearray(26)
    pkt[0:5] = V3_PREAMBLE
    pkt[5] = 0x01
    pkt[6:8] = (0x0017).to_bytes(2, "little")
    pkt[8:10] = (0x0009).to_bytes(2, "little")
    pkt[10:12] = (seq & 0xFFFF).to_bytes(2, "little")
    pkt[12:24] = HR_MODE_PAYLOAD
    return _finish_v3(pkt)


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


def parse_hr_day(header: bytes, data: bytes, item_count: int) -> dict[str, object]:
    """Parse a dataType 0x03 HR day record.

    Ground truth 2026-10-03 (watch photos ~18:54): date Oct 3, start
    17:16:58 (62218 s), silent_hr 65, zones [98,118,138,157,177]
    (implies max-HR ~196), sparse samples incl. 65 (matches the 17:17
    manual read) and 63 (watch day-min 63). Watch day-max/current 77 is
    NOT in this pull — only 4 of 25 slots filled (manual spot checks,
    no 24/7 monitoring), so min/max must come from fuller days.
    Sample encoding: 2 bytes (delta_s, bpm); deltas accumulate from
    start; slots with bpm outside 30..220 (0xFF/0 filler) are empty.
    """
    if len(header) < 10:
        raise ValueError("hr header too short")
    zones: list[dict[str, int]] = []
    if len(header) >= 25:
        zones = [
            {"thr": header[10 + 3 * i], "min": header[11 + 3 * i]} for i in range(5)
        ]
    samples: list[dict[str, int]] = []
    cursor = int.from_bytes(header[4:8], "little", signed=True)
    for i in range(item_count):
        if 2 * i + 1 >= len(data):
            break
        cursor += data[2 * i]
        bpm = data[2 * i + 1]
        if 30 <= bpm <= 220:
            samples.append({"t_s": cursor, "bpm": bpm})
    return {
        "year": int.from_bytes(header[0:2], "little"),
        "month": header[2],
        "day": header[3],
        "start_time_s": int.from_bytes(header[4:8], "little", signed=True),
        "silent_hr": header[9],
        "zones": zones,
        "samples": samples,
    }


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


def parse_workout_summary(header: bytes, data: bytes) -> dict[str, object]:
    """Parse a dataType 0x04 workout record (100-byte header + data blob).

    Ground truth anchor (first run, Functional Strength Training 2026-10-08):
    start 18:58:40, end 19:14, durations 928 s (15:28), calories 50,
    avg/max/min HR 85/145/63, no distance/steps/VO2max on screen.
    Second anchor (Outdoor Walk 2026-10-08): start 19:45:49, end 20:04,
    durations 1101 s (18:21), calories 85, HR 93/121/74, distance 1.47 km
    (stored 1469 m), steps 2021 (NOT in header — still unlocated, see below),
    avg pace 12'29"/km (= 749 s), avg speed 4.83 km/h (stored 483),
    cadence 111/156 spm, stride 72/73 cm. Internal triangle closes:
    2021/18.35 min = 110 spm, 1469/2021 = 72.7 cm, 1.469/0.306 h = 4.8 km/h.
    Only screen-anchored fields are decoded; [12:16] (125029/517684 —
    maybe steps×256: 517684/256 = 2022.2 vs 2021 shown, unconfirmed),
    [48:56], tail triplets and segment tables await a counting run
    (treadmill with exact steps would nail [12:16]).
    sport_type reads 5 on BOTH runs (strength + walk) — disambiguate with
    a third mode before blessing the enum.

    Data layout: 4-byte zero prefix, then raw bpm bytes at ~5 s intervals
    (180 samples here over 928 s) until the first 0x00, then
    histogram/pace/cadence segment tables (TBD).
    """
    if len(header) < 100:
        raise ValueError("workout header too short")
    start_time_s = header[5] * 3600 + header[6] * 60 + header[7]
    samples: list[int] = []
    for bpm in data[4:]:
        if bpm == 0x00:
            break
        if 30 <= bpm <= 220:
            samples.append(bpm)
    return {
        "version": header[0],
        "year": int.from_bytes(header[1:3], "little"),
        "month": header[3],
        "day": header[4],
        "start_time_s": start_time_s,
        "sport_type": header[8],
        "durations_s": int.from_bytes(header[17:21], "little"),
        "calories": int.from_bytes(header[21:25], "little"),
        "distance_m": int.from_bytes(header[25:29], "little"),
        "avg_hr": header[29],
        "max_hr": header[30],
        "min_hr": header[31],
        "avg_cadence_spm": header[32],
        "max_cadence_spm": header[33],
        "avg_stride_cm": header[34],
        "max_stride_cm": header[35],
        "avg_speed_kmh": round(int.from_bytes(header[36:38], "little") / 100, 2),
        "max_speed_kmh": round(int.from_bytes(header[38:40], "little") / 100, 2),
        "avg_pace_s": int.from_bytes(header[40:42], "little"),
        "fast_pace_s": int.from_bytes(header[42:44], "little"),
        "end_year": int.from_bytes(header[71:73], "little"),
        "end_month": header[73],
        "end_day": header[74],
        "end_hour": header[75],
        "end_min": header[76],
        "hr_samples": samples,
    }
