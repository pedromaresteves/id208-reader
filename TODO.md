# Priority TODO (open items only)

## 1. Workout mode byte — blocked on an unpullable history (only item left)
- Known icon→record pairs: 08/10 Functional Strength, 08/10 + 09/10 Outdoor
  Walk. Header byte `[8]` reads 5 on strength AND walk → NOT the mode.
  Header byte `[10]` reads 0 (strength) vs 1 (walk) → lead candidate.
- Two hypotheses: (a) `[10]` is the mode enum, or (b) it's an indoor/outdoor
  flag. Official IDO tables have no record-ID mapping (only capability bits).
- Status 2026-10-11: watch shows 4 records (Oct 8 strength, Oct 8 walk,
  Oct 9 walk, Oct 11 run 10:25→10:38) but type-04 history returns `items=0`
  at offsets 0–7 (TX-verified, post-restart). Dead models: absolute offsets,
  open-session lock (run is finished). Oct 8 proved read-state (two identical
  offset-0 requests → two different records). Guessed mechanism still open:
  spent cursor, BLE/display store divergence, auto-detected sessions never
  entering history.
- Next experiment: close nRF (dual-master interference), record a 2-min
  closed test workout (stop+save explicitly), pull 16/offset 0 → JSONL.
  Appears → mechanism works, Oct 9/11 specifically unpullable (auto-detect?).
  Empty → history broken watch-side → escalate to Gadgetbridge fork.
- Then: one Outdoor Run record + summary + JSONL. If `[10]` reads a third
  value → (a), fill `SPORT_NAMES` from the three pairs. If it reads 1
  again → (b), hunt the real mode byte with the run's full header.
- No code changes until the bytes speak.

## 2. BPMs in Activity section + Page (done, uncommitted)
- `ui.js` `hrStats`/`hrCell` added, covered in `chart.test.js`.
- `activity.html` joins `Store.list('hr')` by date: new `BPM avg (min–max)`
  column + week footer `BPM avg`/`Rest` + status counts HR days.
- `index.html` Activity snippet shows `M bpm avg (rest R)` when an HR day
  exists for the latest step date.
- Verify on phone: re-download all webapp files together, sync, check
  Oct 13 row shows BPM (capture has silent 61 + 580 samples).
- Redesign 2026-10-13 (done, uncommitted): rolling 7-day window anchored on
  phone today (today first, back 6 days), ‹ Prev 7 / Next 7 › pager (Next
  capped at today), avg footer over visible 7 days, month section removed
  (to be redone). Verified in a node harness: order, 7 rows, range label,
  pager window, avgs (6816 steps / 382 kcal / BPM 70 / rest 61 on fixture).
- Agreed: daily-HR join, single narrow column (middle ground of options 1+2).
- `ui.js`: add `hrStats(samples)` helper — avg/min/max/count from
  `samples[].bpm`, ignore non-numbers.
- `activity.html`: `Store.list('hr')` alongside `steps`, join by `date`.
  Table adds `BPM avg (min–max)`, missing HR renders `—`. Week footer adds
  `Rest <silent> · Avg <x> bpm (n days)`.
- `index.html`: extend Activity snippet to `... steps · N kcal · M bpm avg
  (rest R)` when HR exists for latest step date, else unchanged.
- Tests: node harness for `hrStats` + join (missing day, empty samples,
  plain-number samples).

## 3. Activity history: incremental sync, two buttons (done, uncommitted)
- Root cause proven by health-capture.jsonl (Oct 13): `dailyAuto` asked
  sport/HR at offset 0 (= today) only, so history never entered the store.
- Fixed: multi-day capture (`capSportDays`/`capHrDays` + `upsertDay`),
  each day keyed by header date; `last-sync` meta stamp (only when data
  lands); `dailyAuto({days})` stretches past 7 to cover the gap since last
  sync (cap 30, older gaps pointed at full-history); new `syncAll()` macro
  (sport/HR 0..30, wider sleep sweep, workouts 0..15, early-stop on empty
  or repeats). Dashboard = 7-day path, Pull "B. Sync full history" = all.
  Guards in `capture.test.js` (multiday keys, stamp, helpers). NOTE: "since
  Oct 14" was a date slip — today is Oct 13; the 12th fills in on next sync
  if the watch holds it.
- REBOOT TEST 2026-10-13 (Forget + watch reboot + rebind + Button B):
  no revival. Sport offsets 0–3 all today (items 94/95), HR offsets 0–3 all
  today (items up to 628), sleep offsets 0–7+108 all `items=0`, workouts
  `items=0`. CLOSED: this watch/firmware serves today-only sport/HR and
  zero sleep/workouts over BLE, to our app and VeryFit alike, across
  reboots. History = our store accumulating forward from 2026-10-13 via
  daily syncs (stamp + gap-stretch shipped). Revisit only if a firmware
  update or a new watch changes BLE behavior.
- 2026-11-04 LIVE RE-TEST (Windows Playwright + phone ADB; full evidence in
  docs/WATCH-HISTORY-2026-11-04.md): conclusion CONFIRMED and sharpened.
  `0x0AF6` saveOffset is ignored at every byte offset 0..18226 (replies
  byte-identical except the seq echo) on BOTH bonds; byte14=1 returns
  today, byte14=0 returns the single OLDEST record (2026-10-30, 23048
  steps) at any offset. `0x0AF1` is a black hole on this firmware: refused
  at ATT level on the Windows bond (even after app bind 04 01/04 05), and
  on the phone bond writes are accepted (write request AND write command,
  single 137B AND 20B-chunked) but never answered — no 0x0AF2 reply exists
  in any capture. Count-data (04/06/07) empty at all offsets. `0x05` on
  `0x0AF6` replies totalBytes≈18.2KB (~6 day-records Oct 30→Nov 4) but the
  middle days are not addressable over BLE. `syncAll` now also pulls the
  one reachable oldest record per day-data type (`pullOldestDay`, byte14=0
  @0). History = our store accumulating forward + that oldest record.

## 4. Sleep page: missing night of the 12th (implement first)
- Symptom: no record with `night 2026-10-12`; watch shows no previous
  nights, browser has nothing.
- Suspects: (a) sleep pager only asks offsets `0` then hardcoded `108` x7
  (`ble.js:380-389`) — at most 2 distinct nights per sync; (b)
  `sleep.html` drops `total_min==0` partials, hiding in-progress nights.
- Fix: pager uses distinct offsets (0–7 or byte-size stepping per
  `decoder.py` comment — verify against next JSONL); keep `items==0`
  phantom guard; log skipped zero-nights to Pull log so arrival is visible.
- Need from user: next Pull JSONL after fix (sleep rounds 1–8 log lines)
  to tell watch-side retention gap from offset bug.

## 5. Workouts page: empty rows (done, uncommitted — hide only, no delete)
- User choice: filter display, keep store untouched.
- `workout.html`: hide records where `durationsS` missing/0 AND `kcal`
  missing/0 AND `samples` empty AND `avgHr/maxHr/minHr` all missing.
  Explicitly exclude `no-date-*` keys from week list. Status line shows
  `X shown, Y hidden empties`. Add "show hidden" toggle (default off).
- Test: phantom `items=0` shape + dateless shape → zero visible rows,
  count line correct.

## 6. VeryFit HCI capture (closed 2026-10-13 — verdict reached without packets)
- Watch ground truth 22:33: 7448 steps / 397 kcal / 5.47km Oct 13, sleep
  last night 6h12, 4 workout records on-screen (run 11th, walks 9th+8th,
  strength 8th).
- KEY RESULT: VeryFit itself shows steps/BPM/kcal but NO sleep or workout
  data — identical gaps to our app. Watch-side confirmed (display store vs
  BLE-history divergence, as hypothesized in §1); not our decoder.
- HCI packet capture BLOCKED without root (Samsung A52s): `/sdcard/btsnoop_hci.cfa`
  from RTK config never materializes; `/data/log/bt`, `/data/misc/bluetooth`
  all Permission denied; bugreport bundles no btsnoop file (only a
  proprietary BTSNOOP_LOG_SUMMARY blob). Last no-root path untried:
  dialer `*#9900#` SysDump → copy logs to sdcard. Value now LOW anyway —
  vendor app fails identically, so magic unlock bytes are unlikely.
- Cheaper next experiment first: reboot watch (hold button) → Pull Button B
  → if sleep/workouts revive, BLE store was wedged; if still `items=0`,
  store is what it is and daily accumulation is the history.
- Android: Dev options → Wireless debugging on + Bluetooth HCI snoop log on.
- Force-stop our page, open VeryFit, one full sync (Oct 14+ steps +
  night-of-12th on watch). Note screen numbers first.
- `adb bugreport` / pull `btsnoop_hci.log`, filter `btatt` / `0xaf0` in
  Wireshark + `pull.html → Download JSONL` of same state for diffing.
- Scrub full MAC (keep first 3 octets), drop in `captures/`.
- Caution: after VeryFit bonds, our page loses `0x0AF2` notify until
  Forget ID208 in system BT + reboot watch; do VeryFit capture first,
  then re-bind ours with A. Setup watch.

## Done (kept for the record)
- Empty/phantom workouts (old items 1+3): root cause proven 2026-10-11 —
  empty-history START replies (`items=0`, 100 zero bytes) decoded as
  all-zeros records saved under `<date> 0`. Fixed in `ble.js` (ignore
  `items == 0` for types 04/07, header-date stamp), guards in
  `capture.test.js` use the real Oct-11 phantom bytes. Uncommitted.
- Watch settings page (old 4): done, committed.
- Distance 2 decimals (old 5): done, committed.
