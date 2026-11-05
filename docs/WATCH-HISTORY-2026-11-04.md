# Watch history investigation — 2026-11-04 (Windows Playwright session)

Live session against the real ID208 Plus over WebBluetooth from **headed
Windows Chrome**, driven by `scripts/playwright-watch/watch_test.py` via the
Windows Python (`/mnt/c/.../Python313/python.exe`) from WSL. The user clicked
the watch in the native Windows picker (Playwright cannot click native
dialogs). Webapp served from WSL on `http://localhost:8080` (WSL2 forwards
localhost to Windows; secure context, so `navigator.bluetooth` is available).

Artifacts (all in `scripts/playwright-watch/`):
`connect-*`, `auto-sync-*`, `full-sync-*`, `probe-*` — each with
`-log.txt`, `.jsonl` (raw BLE frames), `-store.json` (IndexedDB dump),
`-decoded.html`.

## Session facts

- Connect: `Device Selected: ID208 Plus`, all four chars attached
  (`0x0AF6/0x0AF7/0x0AF1/0x0AF2`), notify ON both, `02 01` → **pair=1,
  bind_flag=2** (bound to the phone; Windows is a second OS-level bond).
- First connect attempt dropped GATT right after `connect()` ("GATT Server is
  disconnected") — fixed in `ble.js` with `setupLinkWithRetry` (3 attempts);
  attempt 1 won on the re-run.
- **`0x0AF1` writes are refused on the Windows bond**: every write fails with
  `NotSupportedError: GATT operation not permitted` (79 failed writes in the
  probe log). `0x0AF6` writes work fine. Chrome reports `properties` as `{}`
  for both chars on Windows.
- **`0x05` sizes query works on `0x0AF6` as a long write** (new fallback in
  `primeOffset05`): the watch replies on `0x0AF7` with
  `totalBytes=18196`, payload exactly 5 B (`14 47 00 00 00`) — just the u32
  total, **no per-type records**. Only the first all-zero-offset `0x05` gets a
  reply; per-round primes with nonzero offsets are silent.

## Probe results (all-types offset probe, `probe.jsonl`)

TX `0x04` START offsets correlated with RX replies (payload MD5 identical =
byte-identical reply):

| Type | Offsets tried | Result |
|------|---------------|--------|
| 08 sport | 0, 506, 1012, … 5606 (stepped) + 100…200000 (sweep) | **always today** (2026-11-04, 819 steps); payload MD5 `8d8b88a1` for offsets 0–3036, `f9765251` for ≥3542 (data window shifts, header always today) |
| 03 HR | 0, 507, … 5577 (stepped) | **always today** (2026-11-04, 238 items); identical payload `5cb8f09a` at every offset |
| 01 SpO2 | 0, 49 | offset 0 → today (18 samples, 97–99%); offset 49 → `items=0` (stream is exactly 49 B — **offset honored**) |
| 02 pressure | 0, 117 | offset 0 → today (52 stress samples); offset 117 → `items=0` (**offset honored**) |
| 07 sleep | 0 ×3 (cursor) + stepped | `items=0` every time — empty store |
| 04 workout | 0 ×3 (cursor) + stepped | `items=0` every time — empty store |
| 06 swim | 0 ×3 (cursor) + stepped | `items=0` every time — empty store |

**Conclusion: from this host, day-data byte offsets (sport/HR) are ignored —
the watch always returns today's record. Count-data stores (sleep/workout/
swim) are empty over BLE. SpO2/pressure offsets work but their streams hold
only today.** The `0x05` prime sent on `0x0AF6` does **not** set the resume
position; per VeryFit research (d3nd3/toobur-veryfit-research
`LATEST_SYNC_PARSING.md`), v3 health writes belong on **`0x0AF1`** with
replies on `0x0AF2`, and the per-type `0x05` offset is what sets the internal
resume position. That channel is exactly the one Windows refuses.

## What the watch holds vs what we can reach

- `0x05` total = **18196 bytes** of stored health data.
- Reachable today via `0x0AF6`: sport 506 B + HR 507 B + SpO2 49 B +
  pressure 117 B ≈ **1.2 KB**. So ~17 KB is stored but not reachable through
  `0x0AF6` offsets from this host — presumably the history that needs the
  `0x0AF1`-primed resume position.
- Store after full sync (`full-sync-store.json`, 7 rows): today's steps
  (819), HR day (238 samples), SpO2 day (18 samples), pressure day
  (52 samples), last-sync meta, plus 2 empty `raw-1` markers (fixed after
  the run: `items=0` markers for types 01/02 are no longer stored).

## Fixes shipped in this session (webapp/ble.js, pull.html, watch_test.py)

1. `dailyAuto` [Pull 2/9] sizes write was unguarded — a missing/refusing
   `0x0AF1` killed the whole sync before any data was pulled (likely the
   "broke yesterday" symptom). Now guarded + falls back to `0x0AF6`.
2. `primeOffset05` now falls back `0x0AF1` → `writeValueWithoutResponse` →
   `0x0AF6` long write, and only waits for a `0x05` reply once one has ever
   arrived (`sawSizesReply`) — silence no longer stalls every round 5 s.
3. `setupLinkWithRetry`: GATT connect + service/char/notify setup retried 3×
   (watch drops the link when another host holds it).
4. Full `0x05` reply payload logged + speculative per-type record parse.
5. **SpO2 (01) and pressure (02) are now pulled** in `dailyAuto`/`syncAll`,
   decoded (7003 header like HR; 2 B items delta+value; SpO2 range 50–100,
   pressure 0–100 — per Gadgetbridge `TooburV3DayMetricParser`), stored under
   `spo2`/`pressure`, with manual buttons 22–25 on pull.html. `items=0`
   markers ignored.
6. Generic `pageType()` pager replaces 7 copy-pasted loops; `syncAll` now
   pages sport/HR/SpO2/pressure up to 60 rounds and sleep/workouts/swims up to
   30; probe button C is now an **all-types offset probe** (day-data stepped,
   sport coarse sweep 100–200000, count-data repeated offset-0 cursor test).
7. `watch_test.py`: streams log lines live, dumps the IndexedDB store
   (`Store.exportJSON()`), saves JSONL per phase, UTF-8-safe output (Windows
   cp1252 crashed earlier runs), uses OS-paired device via `getDevices()`
   when available, waits for the post-connect auto-sync before full sync.
8. `decoder.py`: `build_v3_sizes_05(seq, offsets)` mirrors the JS offsets map
   (byte-identical builders rule); test added.

## Next steps to unlock the ~17 KB of history

1. **Diagnose the `0x0AF1` refusal on Windows**: try
   `writeValueWithoutResponse` explicitly (props read `{}` on Windows Chrome,
   so `writeValue` may pick the wrong write type), check link encryption /
   bond security level. A one-off diag script can try each write variant and
   log which succeeds.
2. **Try bind/auth from Windows** (macro A: `04 01` + `04 05` challenge⊕MAC):
   if the watch accepts the bind from this host, `0x0AF1` writes may start
   being permitted. Cost: re-binds the watch to Windows (phone loses its
   bind slot until re-run on the phone).
3. **Re-run the probe once `0x0AF1` works**: expect sport/HR offsets to
   start returning previous days; then point `syncAll` at the working
   mechanism.
4. **Alternative: run the same probe from the phone**, where `0x0AF1` writes
   succeed (Oct captures show TX on `0x0AF1`) — the phone bond may allow the
   resume-prime and reveal whether history is reachable at all.
5. If neither host can page day-data, the BLE-accessible store is
   today-only (consistent with the 2026-10-13 reboot test in TODO.md §3) and
   history = our store accumulating forward via daily syncs.

## Addendum — 2026-11-04 live re-test: all "next steps" executed, verdict reached

All five next steps above were run live (Windows Playwright via
`watch_diag.py`, phone Chrome via ADB + `phone_adb_probe.py`; the phone was
paired over wireless debugging `adb pair/connect <phone-ip>:<port>`,
webapp served to the phone as `http://localhost:8080` via
`adb reverse tcp:8080 tcp:8080`).

### Results

| Experiment | Result |
|---|---|
| `0x0AF1` writeValue / writeValueWithResponse (Windows) | FAIL `NotSupportedError: GATT operation not permitted` |
| `0x0AF1` writeValueWithoutResponse (Windows) | resolves at OS level, watch never answers (silent drop) |
| App bind from Windows (`04 01`→`03 23`→`04 05`, reply `status=0` accepted), then re-test | `0x0AF1` still refused — link-security, not app-bind |
| `0x0AF1` on the PHONE bond: single 137B write, 20B-chunked, Write Request AND Write Command (props `{}` on phone Chrome too) | writes accepted, **zero replies on 0x0AF2** (notify confirmed ON) — black hole on this firmware |
| Oct captures audit | all 114 v3 RX frames in `captures/*.jsonl` arrived on `0x0AF7` answering `0x0AF6` writes; the 12 `0x05` + 6 `0x04` frames ever sent on `0x0AF1` were never answered |
| `0x0AF6` day-data saveOffset sweep 0…18226 (both bonds, with/without `0x05` prime, with/without STOP, cursor repeats) | replies byte-identical except seq — offset fully ignored |
| `0x04` byte14=0 @0 on `0x0AF6` | **single OLDEST record: 2026-10-30, sport 23048 steps / 96 items, HR 1091 items, SpO2 25, pressure 74** — same at any offset |
| `0x04` byte14=1 @0 on `0x0AF6` | today's record only |
| `0x04` count-data 04/06/07 at 16 offsets up to 18226, both byte14 values | `items=0` everywhere — stores empty over BLE |
| `0x05` on `0x0AF6` | replies `totalBytes≈18.2KB` (~6 day-records Oct 30→Nov 4) — bytes exist but are not addressable |
| operate=2/3, byte14=2/3/0xFF | no reply / same records — byte14 is binary (1=today, else=oldest) |

### Verdict

On the ID208 Plus FW v1.01.17 the BLE-reachable history is exactly
**today (byte14=1) + the single oldest record (byte14=0)**. The middle days
counted by `0x05` cannot be served: `saveOffset` is ignored on the only live
channel (`0x0AF6`) and the channel that would honor it (`0x0AF1`) never
answers on any bond. VeryFit shows the same gaps (TODO.md §6); the on-screen
history lives in a separate UI store (TODO.md §3). History for our app =
the store accumulating forward via daily syncs, plus the oldest record.

### Shipped with this addendum

- `ble.js`: `buildV3Start04(dataType, offset, b14Override)` (default
  unchanged; byte-identical mirror `build_v3_start_04(..., byte14=None)` in
  `decoder.py`, hex vectors pinned in `test_decoder.py` + `capture.test.js`).
- `ble.js`: `probeViaF1()` + pull.html button **D** — stepped-offset
  `0x05`+`0x04` on `0x0AF1`, 20B-chunked, write-command-first; aborts cleanly
  where `0x0AF1` is unwritable.
- `ble.js`: `pullOldestDay(type)` — one byte14=0 @0 round per day-data type
  inside `syncAll`, so the oldest record lands in the store.
- `scripts/playwright-watch/watch_diag.py` — Windows live-diag driver
  (phases PH1–PH9, `--bind`, `--ph7/8/9`, persistent Chrome profile).
- `scripts/playwright-watch/phone_adb_probe.py` — phone driver over plain
  ADB (uiautomator taps + dumps; you click only the native BT picker),
  `adb reverse tcp:8080 tcp:8080` serves the webapp to the phone as
  localhost (secure context → WebBluetooth available).

## 2026-11-05 addendum — the cursor DOES page; 11-04 verdict superseded

`scripts/playwright-watch/history_probe.py` (Windows Playwright, headed Chrome,
`0x0AF6` only) tested START(oper=0, byte14=0, off=0) followed by a **matching
STOP(oper=1, byte14=0, off=0)** — the one combination the 11-04 matrix never
sent, because `buildV3Stop04()` cloned the START default (byte14=1 for
01/02/03/08).

| type | rounds (date @ items) | end |
|---|---|---|
| 08 sport | 10-31 @96, 11-01 @96, 11-02 @96, 11-03 @96, 11-04 @96 | `items=0` |
| 03 HR | 10-31 @1178, 11-01 @1446, 11-02 @1060, 11-03 @530, 11-04 @564 | `items=0` |
| 01 SpO2 | 10-31 @28, 11-01 @20, 11-02 @29, 11-03 @22, 11-04 @25 | `items=0` |
| 02 pressure | 10-31 @69, 11-01 @64, 11-02 @89, 11-03 @64, 11-04 @67 | `items=0` |

- One **completed** day per START+STOP round, oldest first. `saveOffset`
  stays ignored; no `0x05` prime is needed.
- Today is not in that stream: `b14=1` returned 2026-11-05 (95 steps, 31
  items) after the day rolled over, while `b14=0` still ended at 11-04.
- Cursor lifecycle: a second session (new Chrome context, reconnect) got
  `items=0` for every type immediately — the cursor persists. The
  `--rewind` matrix (b14=1 today pull; `0x05` all-zero; `0x05` per-type 0;
  bare STOP ×2) did not rewind it. `0x05` totalBytes fell 18226 → 989
  (unsynced bytes). Reboot / day-rollover rewind untested.
- Header layouts re-confirmed against the probe bytes: sport headSize 36
  (steps @8, raw kcal @12, distance @16, activeMin @20, display kcal @26);
  HR 31 (startS @4, silent @9, five zones @10+3z, dataSize @25); SpO2 and
  pressure 13 (startS @4, dataSize @9). HR items are 2-byte (delta s, bpm)
  with `(0xFF,0x00)` = a 255 s gap, so the decoder's 30–220 filter is right.

### Shipped with this addendum

- `ble.js`: `buildV3Stop04(dataType, b14Override)`, `pullToday`,
  `pageDayHistory`; `dailyAuto`/`syncAll` pull today (b14=1) then drain the
  completed-day cursor (b14=0); `pullOldestDay` removed.
- `decoder.py`: `build_v3_stop_04` mirror; byte vectors pinned in
  `webapp/capture.test.js` and `tests/test_decoder.py`.
- `scripts/playwright-watch/history_probe.py`: the live probe (`--rewind`
  for the cursor-lifecycle matrix).

### 2026-11-05 follow-up — reboot does not rewind; empty-marker guards

- A button reboot did **not** rewind the cursor: the next sync returned
  `items=0` for all four day-data types. The BLE queue is one-shot for the
  watch's lifetime (factory reset not tested). `b14=1` still returns today.
- That sync exposed the terminal `items=0` frame being decoded as data:
  sport's zeroed header fell back to the phone date and **overwrote today's
  real record with zeros**, and HR stored a `0-0-0` day. Both types now
  ignore `itemCount == 0` (like sleep/workouts/swim/SpO2/pressure), with
  regression coverage in `webapp/capture.test.js`.
- Recovery: `captures/history-probe-2026-11-05.jsonl` (gitignored) decodes
  to `out/steps.csv` / `out/hr.json`; `out/import-2026-11-05.json` is the
  combined import for pull.html (restores 10-31…11-04 into the store).
