# Plan — ID208 Plus without VeryFit

## Goal
No-account, no-ads reader for ID208 Plus (FW v1.01.17) on Android 14 + WSL2 Ubuntu.
Wanted data only: steps, distance walked, active time, sleep.

Constraints:
- No VeryFit (forced accounts, cluttered, slow, ads/popups). Uninstalled.
- No alternative that forces accounts.
- All work stays in `/home/pedro/id208-reader` on Linux filesystem, never `/mnt/c`.
- Success rule: numbers in our tool match what the watch screen shows.

## Progress (2026-10-01)
- [x] Watch ground truth 18:31: Activity 5736/8000 steps, 468/500 kcal; Sleep 07h05m (425 min), 23:47 -> 06:52 (see `captures/watch-2026-10-01-a/b.jpeg`, `captures/README.md`).
- [x] `phase0/health.html` built from `d3nd3/toobur-veryfit-research` wire spec: notify `0x0AF7`+`0x0AF2`, `02 01`/`02 A0` on `0x0AF6`, v3 `0x05` sizes + `0x04` START/STOP (sport 08, sleep 07) on `0x0AF1` with CRC-16-CCITT. Sequential connect + 500 ms CCCD gap fixed `NotSupportedError`.
- [x] Live session saved to `captures/health-2026-10-01-manual.jsonl`: `02 01` -> device_id 7982/energy 42; `02 A0` -> `8A 1A...` (layout TBD); builders verified byte-identical to page TX.
- [x] `src/ido/decoder.py` grown: `build_v3_sizes_05` / `build_v3_start_04` / `crc16_ccitt` / `parse_v3_health_common` / `parse_sport_summary` / `parse_sleep_summary` + tests anchored to 5736 steps / 425 min (`pytest` 7 passed, `ruff` clean).
- [ ] Still missing: any `0x0AF2` reply to v3 START (watch silent; try 30 s wait + STOP, or stale-bond forget/reboot). Also need same-moment screen steps/kcal to anchor `02 A0` layout, and the page's Download JSONL file.
- [ ] Stray `07 40 1F 00 00 00 00` notify on `0x0AF7` at connect — unknown, possibly auth/pair hint.

## Progress (2026-09-29)
- [x] Phase 0 transport PASS via `phase0/idowatch.html` on Android 14 Chrome (`content://media/e`, local file): `Device Selected > Connected > Receiving Notifications > Received Basic Info - Requesting Activity > Receiving Data > Received Activity > Not version we support: 0` (see `captures/whatsapp-2026-09-29-221842.jpeg`).
- [x] Live `02 01` reply decodes with existing `src/ido/decoder.py` layout: raw `02 01 2E 1F 01 01 00 33...` -> `device_id 7982 (0x1F2E), firmware_version 1, mode 1, batt_status 0, energe 51, pair 1`.
- [x] Activity `version == 0` (empty, no unsynced running) — expected: demo page handles running/TCX only, never daily steps/sleep. Not blocking.
- [ ] Still missing: one health-sync dump (`0x0AF1` write -> `0x0AF2` notify) + watch-screen numbers for steps/sleep decoder. (2026-10-01: page/proc ready, watch silent so far — see 2026-10-01 entry.)

## Progress (2026-09-27)
- [x] Phase 0A PASS: `nRF Connect` shows `ID208 PLUS`, service `0x0AF0` with `0x0AF6` (READ/WRITE), `0x0AF7` (NOTIFY), `0x0AF1` (WRITE), `0x0AF2` (NOTIFY). MAC prefix `F4:60:CC` (see `captures/imga.jpeg`, scrub full MAC before sharing).
- [~] Phase 0B partial: `xssfox/idowatch` demo page vendored to `phase0/idowatch.html` (repo shows code only, button lives in `htmlapp/index.html`). Not blocking — page covers running/TCX only, not our steps/sleep target.
- [x] Phase 1 scaffold DONE: `pyproject.toml`, `src/ido/decoder.py` (constants + `02 01` parser), `tests/test_decoder.py` (3 passed), `sync.py` (BLE scan skips cleanly on WSL/no-BlueZ, writes `out/steps.csv` placeholder), `ruff check` + `ruff format --check` clean.
- [x] Env: project-local `.venv` bootstrapped via `get-pip.py` + `venv --without-pip` (no sudo needed); `bleak 3.0.2 / pytest 9.1.1 / ruff 0.16.9` installed.
- [x] Guardrails: safe `permission` block applied to `~/.config/opencode/opencode.jsonc` (bash default-ask, `sudo`/`rm -rf`/`git push` denied).

## Background
- Watch speaks IDO/VeryFit BLE dialect (service `0x0AF0`, write `0x0AF6` -> notify `0x0AF7`, health v3 write `0x0AF1` -> notify `0x0AF2`, bind `04 01 F1...`).
- Gadgetbridge 0.93 supports Da Fit, FitPro, GloryFit, ID115 — not IDO/VeryFit.
- Time sync works via standard Bluetooth; fitness needs the proprietary dialect.
- No light account-free app exists today. References: `xssfox/idowatch`, `idoosmart/idowatch`, `orangebrush/angelfit`, `d3nd3/toobur-veryfit-research`, `VeryLoad`.

## Phase 0 — Prove decodable, no code (~30 min)
1. Android 14 Chrome: open `xssfox/idowatch` demo -> Pair + Get Activity, VeryFit killed so it does not steal connection.
2. Record: pass/fail, BT name/MAC prefix, `nRF Connect` service dump confirming `0x0AF0` set, watch FW, last VeryFit version.
3. If fail: stop, variant differs — fallback is replace watch with natively supported model.

## Phase 1 — Clean harness
- Stack: Python + `bleak` + `pytest` + `ruff`, JSONL captures. Reason: fastest AI-assisted RE loop, no Android Studio.
- Layout:
  - `captures/` raw JSONL (never commit personal data without scrubbing)
  - `src/ido/decoder.py` strict decoders
  - `tests/test_decoder.py` fixtures from captures
  - `sync.py` -> `out/steps.csv`, `out/sleep.json`
  - No network, no account, local only.
- AI workflow: one capture + known table -> generate decoder + test -> verify vs watch display.

## Phase 2 — Decoders (in order)
1. Steps / distance / active time (simplest).
2. Sleep.
3. Deferred: HR, SpO2, workouts/GPX.
- Verification: 3 days compare tool vs watch screen, log mismatches in `captures/README.md`.

## Phase 3 — Daily use
- Short term: `sync.py` on Linux, copy CSV.
- Long term, pick one:
  - A) Phone web page via WebBluetooth (decoder ported to TypeScript, Android Chrome, no install).
  - B) Port working decoder to `d3nd3/gadgetbridge-veryfit` fork, propose upstream to Gadgetbridge with `btsnoop_hci.log`.

## Risks
- Sleep format varies by FW; bind may be required before sync.
- Community fork is experimental, not F-Droid signed.
- Upstream Gadgetbridge support is days-weeks, needs captures + Java port.

## Next step
1. Phone (`phase0/health.html`, re-download latest): Connect -> sizes -> wait 30 s -> sport START -> wait 30 s -> STOP -> sleep START -> wait 30 s -> STOP. Save Download JSONL to `captures/`.
2. At the same minute, note current watch steps/kcal + time (anchors `02 A0` layout; photo numbers are from 18:31, live reply is newer).
3. Then grow `src/ido/decoder.py` (`parse_live_data`, real sport/sleep asserts vs JSONL) with tests against the watch screen.
Old note: Health-sync dump for steps/sleep into `captures/` (via `nRF Connect` log on `0x0AF1`/`0x0AF2`, MAC scrubbed to `F4:60:CC` prefix) + photo of watch screen numbers at same time, then grow `src/ido/decoder.py` to decode steps/sleep with tests against the watch screen.
