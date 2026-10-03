"""Tests for the 0x0AF0 decoder scaffold (Phase 1)."""

import pytest

from ido.decoder import (
    CHAR_HEALTH_NOTIFY,
    CHAR_HEALTH_WRITE,
    CHAR_NOTIFY,
    CHAR_WRITE,
    SERVICE_UUID,
    build_v3_sizes_05,
    build_v3_start_04,
    crc16_ccitt,
    parse_basic_info,
    parse_live_data,
    parse_sleep_summary,
    parse_sport_summary,
    parse_v3_health_common,
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
