# captures/

Raw BLE captures as JSONL (one frame per line, hex + timestamp).
Already here: `imga.jpeg` (Phase 0 Test A service dump).
Also here: `whatsapp-2026-09-29-221842.jpeg` (2026-09-29 Phase 0 transport PASS via `phase0/idowatch.html` on Android Chrome).

2026-09-29 transcript (from screenshot debug log):
- Events: `Device Selected > Connected > Receiving Notifications > Received Basic Info - Requesting Activity > Receiving Data > Received Activity > Not version we support: 0`.
- Basic-info reply: `02 01 2E 1F 01 01 00 33...` -> `device_id 7982, firmware_version 1, mode 1, batt_status 0, energe 51, pair 1` (matches `src/ido/decoder.py`).
- Activity packet: `33 DA AD DA AD 01...` mostly zeros, `version == 0` = no unsynced running activity. Expected — demo page is running/TCX only.
- Still needed: `0x0AF1`/`0x0AF2` health-sync dump + watch screen numbers.

Privacy: scrub full MACs before committing (keep first 3 octets only).

## Ground truth 2026-10-01 18:31 (watch screen)
- `watch-2026-10-01-b.jpeg` (Activity): 5736/8000 steps, 468/500 kcal.
- `watch-2026-10-01-a.jpeg` (Sleep): 07h05m total (425 min), bed 23:47 -> wake 06:52.
- Success rule: decoder output must equal these numbers.

## Session 2026-10-01 evening (`health-2026-10-01-manual.jsonl`, from `phase0/health.html`)
- Connect OK: `0x0AF6/0x0AF7/0x0AF1/0x0AF2` all attach, notify ON both (500 ms gap).
- `02 01` -> `02 01 2E 1F 01 01 00 2A...` = device_id 7982, fw 1, energy 42. Builders verified byte-identical to page TX.
- `02 A0` -> `02 A0 8A 1A 00 00 C0 07 00 00 FB 13 00 00 13 00 00 00 F0` (live layout TBD — needs same-moment screen numbers).
- v3 `0x05` + `0x04` START (sport 08 seq 0x61, sleep 07 seq 0x62) sent on `0x0AF1`, **no `0x0AF2` reply captured yet** — watch may need >30 s wait, STOP, or bind.
- Stray `07 40 1F 00 00 00 00` notify on `0x0AF7` right after connect (unknown, possibly auth/pair hint).

## Resume checklist (next session)
1. Re-download `phase0/health.html` to phone (latest has 8 buttons + 500 ms CCCD gap + copy fallback).
2. Capture run: sizes -> wait 30 s -> sport START/STOP -> sleep START/STOP; Download JSONL into `captures/`.
3. Same-minute watch numbers (steps/kcal/time) to anchor `02 A0`.
4. Paste new `RX [0x0AF2]` lines here; then implement `parse_live_data` + real-data asserts.
