"""Tests for the 0x0AF0 decoder scaffold (Phase 1)."""

import pytest

from ido.decoder import (
    CHAR_HEALTH_NOTIFY,
    CHAR_HEALTH_WRITE,
    CHAR_NOTIFY,
    CHAR_WRITE,
    SERVICE_UUID,
    build_auto_activity,
    build_bind_auth,
    build_bind_auth_probe,
    build_bind_start,
    build_bind_stop,
    build_goals_sample,
    build_hr_mode,
    build_set_23_sample,
    build_set_time,
    build_units_bind,
    build_units_sample,
    build_user_info_sample,
    build_v3_1a,
    build_v3_sizes_05,
    build_v3_start_04,
    build_weather_off,
    crc16_ccitt,
    parse_basic_info,
    parse_bind_challenge,
    parse_bind_mac,
    parse_bind_reply,
    parse_hr_day,
    parse_live_data,
    parse_sleep_summary,
    parse_sport_summary,
    parse_v3_health_common,
    parse_workout_summary,
)


def test_service_constants_match_phase0() -> None:
    assert SERVICE_UUID == 0x0AF0
    assert (CHAR_WRITE, CHAR_NOTIFY, CHAR_HEALTH_WRITE, CHAR_HEALTH_NOTIFY) == (
        0x0AF6,
        0x0AF7,
        0x0AF1,
        0x0AF2,
    )


def test_parse_basic_info_ok() -> None:
    payload = bytes((0x02, 0x01, 0x34, 0x12, 0x01, 0x00, 0x64, 0x50, 0x01))
    info = parse_basic_info(payload)
    assert info["device_id"] == 0x1234
    assert info["firmware_version"] == 1
    assert info["batt_status"] == 0x64


def test_parse_basic_info_bind_flags() -> None:
    # Fresh-launch sample (unbind mode): 02 01 14 02 11 01 03 0D 01 ...
    payload = bytes.fromhex("020114021101030D010001002802010303000000")
    info = parse_basic_info(payload)
    assert info["device_id"] == 0x0214
    assert info["firmware_version"] == 0x11
    assert info["pair"] == 1
    assert info["reboot"] == 0
    assert info["bind_confirm_flag"] == 0


def test_bind_builders_and_reply() -> None:
    # Live-verified on A200 (bind-v3.json): TX -> RX 04 01 00 00.
    assert build_bind_start() == bytes.fromhex("0401F1010102020100")
    assert build_bind_stop() == bytes.fromhex("0402F1010102020100")
    reply = parse_bind_reply(bytes.fromhex("04010000"))
    assert reply == {"key": 0x01, "status": 0, "detail": 0}
    with pytest.raises(ValueError):
        parse_bind_reply(bytes((0x02, 0x01, 0x00, 0x00)))


def test_bind_auth_probe_shape() -> None:
    # Bare 2-byte header; the watch stays silent on it (confirmed 2x).
    assert build_bind_auth_probe() == bytes.fromhex("0403")
    assert parse_bind_reply(bytes.fromhex("040300")) == {"key": 3, "status": 0}
    assert build_set_23_sample() == bytes.fromhex("03230200")


def test_bind_auth_finalizes_binding() -> None:
    # Instrumented VeryFit bind 2026-10-08 (captures/veryfit-bind-2026-10-08.log
    # #26-32): trailing 6 = challenge XOR watch MAC. MAC below is synthetic
    # (real vendor prefix, zeroed device bytes — never commit real MACs).
    mac = bytes.fromhex("F460CC000000")
    bind_rx = bytes.fromhex("0401000C00F460CC000000EA0A0812193B")
    assert parse_bind_mac(bind_rx) == mac
    challenge = parse_bind_challenge(bind_rx)
    assert challenge == bytes.fromhex("EA0A0812193B")
    pkt = build_bind_auth(challenge, mac)
    assert pkt == bytes.fromhex("04050C00EA0A0812193B1E6AC412193B")
    assert parse_bind_reply(bytes.fromhex("04050000")) == {
        "key": 5,
        "status": 0,
        "detail": 0,
    }
    with pytest.raises(ValueError):
        parse_bind_challenge(bytes.fromhex("04010000"))
    with pytest.raises(ValueError):
        build_bind_auth(bytes(5), bytes(6))


def test_bind_auth_xor_rule_second_sample() -> None:
    # The stale 18:23 attempt (log lines 1-2) was correctly formed per the XOR
    # rule but rejected (status 02) for a stale challenge — proves the rule
    # independently of the successful sample.
    mac = bytes.fromhex("F460CC000000")
    pkt = build_bind_auth(bytes.fromhex("D0020F06230B"), mac)
    assert pkt == bytes.fromhex("04050C00D0020F06230B2462C306230B")


def test_set_time_and_user_info_builders() -> None:
    # VeryFit logcat sample: 03 01 EA 07 03 08 01 11 18 06 + zeros.
    pkt = build_set_time(2026, 3, 8, 1, 17, 24, 7)
    assert len(pkt) == 16
    assert pkt[:9] == bytes.fromhex("0301EA070308011118")
    assert pkt == bytes.fromhex("0301EA07030801111807000000000000")
    user = build_user_info_sample()
    assert user == bytes.fromhex("0310B4401F00D6070301")


def test_setup_prelude_samples_match_logcat() -> None:
    # Byte-identical to VeryFit fresh-launch TX lines (app_fresh_launch.txt).
    assert len(build_units_sample()) == 17
    assert build_units_sample() == bytes.fromhex("0311010101000201000000010101010000")
    assert len(build_goals_sample()) == 20
    assert build_goals_sample() == bytes.fromhex(
        "0343F40100000000000008070000FA000E060C00"
    )
    assert build_weather_off() == bytes.fromhex("032D55000000")


def test_auto_activity_matches_fork_captures() -> None:
    # Gadgetbridge-veryfit TooburAutoActivitySwitchPackets: off capture and
    # walk+run capture, byte-identical.
    assert build_auto_activity() == bytes.fromhex("0349000000000000000000")
    assert build_auto_activity(walk=True, run=True) == bytes.fromhex(
        "0349010100000000000000"
    )
    pkt = build_auto_activity(bicycle=True, swim=True)
    assert len(pkt) == 11
    assert pkt[2:5] == bytes((0x00, 0x00, 0x01))
    assert pkt[9] == 0x01


def test_setup_prelude_v3_matches_logcat_crc() -> None:
    # Reinstall-bind logcat packets: our builders must reproduce them
    # byte-identically, which also validates the CRC implementation.
    assert build_v3_1a(0x0002) == bytes.fromhex("33DAADDAAD010B001A0002005FF9")
    assert build_hr_mode(0x0003) == bytes.fromhex(
        "33DAADDAAD011700090003000000000000010000173B0000B928"
    )
    assert build_hr_mode(0x0004) == bytes.fromhex(
        "33DAADDAAD011700090004000000000000010000173B0000BF58"
    )
    assert build_units_bind() == bytes.fromhex("0311010101000202000000010101010000")


def test_parse_basic_info_rejects_bad_header() -> None:
    with pytest.raises(ValueError):
        parse_basic_info(bytes((0x33, 0xDA, 0xAD)))


def test_v3_builders_framing_and_crc() -> None:
    sizes = build_v3_sizes_05(0x60)
    assert len(sizes) == 137
    assert sizes[0:5] == bytes((0x33, 0xDA, 0xAD, 0xDA, 0xAD))
    assert int.from_bytes(sizes[8:10], "little") == 0x0005
    assert crc16_ccitt(sizes[1:-2]) == int.from_bytes(sizes[-2:], "little")

    sport = build_v3_start_04(0x08, 0x61)
    assert len(sport) == 19
    assert sport[12] == 0x00 and sport[13] == 0x08 and sport[14] == 0x01
    assert crc16_ccitt(sport[1:-2]) == int.from_bytes(sport[-2:], "little")

    sleep = build_v3_start_04(0x07, 0x62)
    assert sleep[13] == 0x07 and sleep[14] == 0x00

    with pytest.raises(ValueError):
        build_v3_start_04(0x05, 0x63)

    with pytest.raises(ValueError):
        parse_v3_health_common(bytes(13))


def test_v3_start_04_save_offset_bytes_and_crc() -> None:
    # Offset 0 (default) keeps old bytes; nonzero offset lands LE at [15:17].
    default = build_v3_start_04(0x07, 0x63)
    assert default[15:17] == bytes((0x00, 0x00))
    paged = build_v3_start_04(0x07, 0x64, 108)
    assert paged[15:17] == (108).to_bytes(2, "little")
    assert len(paged) == 19
    assert paged[12] == 0x00 and paged[13] == 0x07
    assert crc16_ccitt(paged[1:-2]) == int.from_bytes(paged[-2:], "little")


def test_v3_start_04_hr_type_uses_day_data_byte14() -> None:
    hr = build_v3_start_04(0x03, 0x70)
    assert len(hr) == 19
    assert hr[12] == 0x00 and hr[13] == 0x03 and hr[14] == 0x01
    assert crc16_ccitt(hr[1:-2]) == int.from_bytes(hr[-2:], "little")


def test_v3_start_04_workout_type_uses_count_byte14() -> None:
    workout = build_v3_start_04(0x04, 0x71)
    assert len(workout) == 19
    assert workout[12] == 0x00 and workout[13] == 0x04 and workout[14] == 0x00
    assert crc16_ccitt(workout[1:-2]) == int.from_bytes(workout[-2:], "little")


def test_parse_sport_summary_matches_watch_steps() -> None:
    header = bytearray(28)
    header[8:12] = (5736).to_bytes(4, "little")
    header[12:16] = (468).to_bytes(4, "little")
    header[16:20] = (4100).to_bytes(4, "little")
    out = parse_sport_summary(bytes(header))
    assert out["total_steps"] == 5736
    assert out["total_distance_m"] == 4100


def test_parse_sleep_summary_matches_watch_sleep() -> None:
    header = bytearray(30)
    header[2:4] = (2026).to_bytes(2, "little")
    header[4], header[5], header[6], header[7] = 9, 30, 23, 47
    header[8:10] = (2026).to_bytes(2, "little")
    header[10], header[11], header[12], header[13] = 10, 1, 6, 52
    header[14:16] = (425).to_bytes(2, "little")
    out = parse_sleep_summary(bytes(header))
    assert out["total_min"] == 425
    assert (out["fall_asleep_hour"], out["fall_asleep_min"]) == (23, 47)
    assert (out["get_up_hour"], out["get_up_min"]) == (6, 52)


def test_parse_live_data_matches_watch_10065() -> None:
    # Ground truth 2026-10-03 17:17: 10065 steps / 7.64 km / 631 kcal.
    payload = bytes.fromhex("02A05127000086070000D91D00001E000000F0")
    out = parse_live_data(payload)
    assert out["steps"] == 10065
    assert out["distance_m"] == 7641
    assert out["unknown_u32_2"] == 30
    assert out["tail"] == 0xF0


def test_parse_live_data_matches_watch_10004() -> None:
    # Ground truth 2026-10-03 16:47: 10004 steps / 7.6 km / 622 kcal.
    payload = bytes.fromhex("02A01427000068070000AB1D00001E000000F0")
    out = parse_live_data(payload)
    assert out["steps"] == 10004
    assert out["distance_m"] == 7595


def test_parse_live_data_rejects_bad_header() -> None:
    with pytest.raises(ValueError):
        parse_live_data(bytes((0x02, 0x01, 0x00) * 7))


def test_parse_sport_summary_real_capture_10065() -> None:
    # Real sport header from captures/health-2026-10-03-v3.jsonl (seq 0x61).
    # Watch at 17:17 showed 10065 steps / 7.64 km / 631 kcal.
    header = bytes.fromhex(
        "00EA070A0300000F5127000086070000D91D00001E0000004600770200000A0000000000"
    )
    out = parse_sport_summary(header)
    assert out["total_steps"] == 10065
    assert out["total_distance_m"] == 7641
    assert out["display_kcal"] == 631
    assert out["total_active_min"] == 30


def test_parse_sleep_summary_real_capture_sep28() -> None:
    # Real sleep header from captures/health-2026-10-03-v3.jsonl (seq 0x63).
    # Night of Sep 28: 23:41 -> 07:06, 445 min total.
    header = bytes.fromhex(
        "0201EA07091C1729EA07091D0706BD011500D70088004900"
        "040C0902644C1B000000AAAAAAAAAAAA"
    )
    out = parse_sleep_summary(header)
    assert (out["fall_asleep_year"], out["fall_asleep_month"]) == (2026, 9)
    assert (out["fall_asleep_day"], out["fall_asleep_hour"]) == (28, 23)
    assert (out["fall_asleep_min"], out["get_up_day"]) == (41, 29)
    assert (out["get_up_hour"], out["get_up_min"]) == (7, 6)
    assert out["total_min"] == 445
    assert out["deep_min"] == 73
    assert out["wake_min"] + out["light_min"] + out["rem_min"] + out["deep_min"] == 445


def test_parse_sleep_summary_real_capture_oct1_ground_truth() -> None:
    # Offset-27 record from captures/health-2026-10-03-sleep-paged.jsonl.
    # Recovers the original 2026-10-01 watch ground truth: 425 min, 23:47 -> 06:52.
    header = bytes.fromhex(
        "0201EA07091E172FEA070A010634A9010000D9009B003500"
        "000F0D0364441F000000AAAAAAAAAAAA"
    )
    out = parse_sleep_summary(header)
    assert (out["fall_asleep_day"], out["fall_asleep_hour"]) == (30, 23)
    assert (out["fall_asleep_min"], out["get_up_day"]) == (47, 1)
    assert (out["get_up_hour"], out["get_up_min"]) == (6, 52)
    assert out["total_min"] == 425
    assert out["wake_min"] + out["light_min"] + out["rem_min"] + out["deep_min"] == 425


def test_parse_sleep_summary_real_capture_oct2_newest() -> None:
    # Offset-108 record: newest night so far, Oct 2 00:15 -> 06:51, 396 min.
    header = bytes.fromhex(
        "0201EA070A02000FEA070A0206338C010000D00080003C00"
        "000D0E0364451E000000AAAAAAAAAAAA"
    )
    out = parse_sleep_summary(header)
    assert (out["fall_asleep_month"], out["fall_asleep_day"]) == (10, 2)
    assert (out["fall_asleep_hour"], out["fall_asleep_min"]) == (0, 15)
    assert (out["get_up_hour"], out["get_up_min"]) == (6, 51)
    assert out["total_min"] == 396
    assert out["deep_min"] == 60
    assert out["wake_min"] + out["light_min"] + out["rem_min"] + out["deep_min"] == 396


def test_parse_sleep_summary_real_capture_oct3_last_night() -> None:
    # Repeat-108 record from captures/health-2026-10-03-sleep-repeat108.jsonl.
    # Same offset returned the NEXT night: Oct 3 03:10 -> 09:22, 372 min.
    # (The watch advances its cursor on STOP; offsets are not addresses.)
    header = bytes.fromhex(
        "0201EA070A03030AEA070A03091674010000000156001E00"
        "00060603643E0F000000AAAAAAAAAAAA"
    )
    out = parse_sleep_summary(header)
    assert (out["fall_asleep_month"], out["fall_asleep_day"]) == (10, 3)
    assert (out["fall_asleep_hour"], out["fall_asleep_min"]) == (3, 10)
    assert (out["get_up_hour"], out["get_up_min"]) == (9, 22)
    assert out["total_min"] == 372
    assert out["deep_min"] == 30
    assert out["wake_min"] + out["light_min"] + out["rem_min"] + out["deep_min"] == 372


def test_sleep_paging_end_of_history_is_empty() -> None:
    # Repeat-108 once past the newest night (captures/health-2026-10-03-sleep-end.jsonl):
    # the watch answers START with item_count 0 and a zeroed header.
    # Paging rule: stop when item_count == 0.
    payload = bytes.fromhex(
        "0007006C0000002800000000000000000000000000000000"
        "000000000000000000000000000000000000000000000000"
    )
    common = parse_v3_health_common(payload)
    assert common["data_type"] == 0x07
    assert common["item_count"] == 0
    assert common["data_size"] == 0
    assert set(payload[14 : 14 + common["head_size"]]) == {0}


def test_parse_hr_day_matches_watch_oct3() -> None:
    # Real HR record from captures/health-2026-10-03-hr-first.jsonl (seq 0x60).
    # Watch photos ~18:54: day-min 63; 65 matches the 17:17 manual read.
    # Watch max/current 77 is NOT in this sparse pull (4 of 25 slots).
    header = bytes.fromhex(
        "EA070A030AF3000001416200007600008A00009D0000B1000032000000000000"
    )
    data = bytes.fromhex(
        "0041FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00583F21471B41"
    )
    out = parse_hr_day(header, data, 25)
    assert (out["year"], out["month"], out["day"]) == (2026, 10, 3)
    assert out["start_time_s"] == 62218
    assert out["silent_hr"] == 65
    assert [z["thr"] for z in out["zones"]] == [98, 118, 138, 157, 177]
    bpms = [s["bpm"] for s in out["samples"]]
    assert len(bpms) == 4
    assert min(bpms) == 63
    assert 65 in bpms
    assert out["samples"][0] == {"t_s": 62218, "bpm": 65}


def test_parse_hr_day_rejects_short_header() -> None:
    with pytest.raises(ValueError):
        parse_hr_day(bytes(9), bytes(10), 5)


def test_parse_v3_health_common_ok() -> None:
    payload = bytes(
        (
            0x00,
            0x08,
            0x01,
            0x00,
            0x00,
            0x02,
            0x00,
            0x24,
            0x00,
            0x10,
            0x00,
            0x00,
            0x00,
            0x00,
        )
    )
    common = parse_v3_health_common(payload)
    assert common["data_type"] == 0x08
    assert common["item_count"] == 2


def test_parse_workout_summary_matches_first_run() -> None:
    # First run: Functional Strength Training 2026-10-08.
    # Watch summary: 15:28, 50 kcal, avg/max/min HR 85/145/63, no
    # distance/steps/VO2max shown. From
    # captures/health-2026-10-08-workout-first.jsonl (head + data start).
    header = bytes.fromhex(
        "10ea070a08123a280500000265e8010000a00300003200000085010000"
        "55913f1caf4f509000f60451091d010000000036000000440000000700"
        "00000000000000000000070000ea070a08130e0b100001000100b800b8"
        "00b8000000000000000a08130e"
    )
    data = bytes.fromhex(
        "00000000413f424342444648494846484a4a4e4f4c4c4e4e5051535351"
        "515453535452514d484646484a4b4b4e555b5d5b5a59585655595b5c5e"
        "63666766646365666867635f5c595b5b59585656585a58585654525352"
        "5456565755535455565655524f4f5254575b6062615d57535354524f4e51"
        "53504e4f4d4d4e5154555455595d59565958565858534a484d5151504c"
        "4949494948484845464a4c4c4e50525456585b606670767c8084868380"
        "7c7b7d818180858d910000010000000000020000000e0003000a000000"
        "02000000000004000000000004000000"
    )
    out = parse_workout_summary(header, data)
    assert out["version"] == 16
    assert (out["year"], out["month"], out["day"]) == (2026, 10, 8)
    assert out["start_time_s"] == 18 * 3600 + 58 * 60 + 40
    assert out["sport_type"] == 5
    assert out["durations_s"] == 928
    assert out["calories"] == 50
    assert (out["avg_hr"], out["max_hr"], out["min_hr"]) == (85, 145, 63)
    assert (out["end_year"], out["end_month"], out["end_day"]) == (2026, 10, 8)
    assert (out["end_hour"], out["end_min"]) == (19, 14)
    samples = out["hr_samples"]
    assert len(samples) == 180
    assert min(samples) == 63
    assert max(samples) == 145


def test_parse_workout_summary_rejects_short_header() -> None:
    with pytest.raises(ValueError):
        parse_workout_summary(bytes(99), bytes(10))


def test_parse_workout_summary_walk_pins_distance_pace() -> None:
    # Second run: Outdoor Walk 2026-10-08, built synthetically at verified
    # offsets (real head in captures/health-2026-10-08-workout-walk.jsonl).
    # Watch: 18:21 (1101 s), 85 kcal, HR 93/121/74, 1.47 km, 2021 steps,
    # avg pace 12'29", 4.83 km/h, cadence 111/156 spm, stride 72/73 cm.
    header = bytearray(100)
    header[0] = 16
    header[1:3] = (2026).to_bytes(2, "little")
    header[3], header[4], header[5], header[6] = 10, 8, 19, 45
    header[7] = 49
    header[8] = 5
    header[17:21] = (1101).to_bytes(4, "little")
    header[21:25] = (85).to_bytes(4, "little")
    header[25:29] = (1469).to_bytes(4, "little")
    header[29], header[30], header[31] = 93, 121, 74
    header[32], header[33], header[34], header[35] = 111, 156, 72, 73
    header[36:38] = (483).to_bytes(2, "little")
    header[38:40] = (766).to_bytes(2, "little")
    header[40:42] = (749).to_bytes(2, "little")
    header[42:44] = (469).to_bytes(2, "little")
    header[71:73] = (2026).to_bytes(2, "little")
    header[73], header[74], header[75], header[76] = 10, 8, 20, 4
    out = parse_workout_summary(bytes(header), bytes((0, 0, 0, 0, 90, 95, 0)))
    assert out["durations_s"] == 1101
    assert out["calories"] == 85
    assert out["distance_m"] == 1469
    assert (out["avg_hr"], out["max_hr"], out["min_hr"]) == (93, 121, 74)
    assert (out["avg_cadence_spm"], out["max_cadence_spm"]) == (111, 156)
    assert (out["avg_stride_cm"], out["max_stride_cm"]) == (72, 73)
    assert out["avg_speed_kmh"] == 4.83
    assert out["max_speed_kmh"] == 7.66
    assert out["avg_pace_s"] == 749
    assert out["fast_pace_s"] == 469
    assert out["hr_samples"] == [90, 95]
