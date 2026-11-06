# Priority TODO (open items only)

## 0. Next steps (in order)
1. **Later / needs reset or broken state:** first-run auto-setup and the
   skew-banner force reload still need a reset watch or a deliberately
   corrupted settings file to exercise live (§4).
2. **Optional hardware:** one fresh swim to complete the count-data check
   (§2); workouts and sleep are already confirmed.

## 1. Workout mode — not exposed in the type-04 record (closed)
- Four confirmed 2026-11-05 records: Outdoor Walk 17:04 (`items=58`),
  Functional Strength 21:14 (`items=4`), Outdoor Run 21:17 (`items=3`),
  Outdoor Walk 22:32 (`items=3`).
- The mode is NOT in the type-04 record:
  - 14-byte common header: identical apart from counts/sizes.
  - 100-byte header: no duration-independent byte separates the modes;
    `[8..11] = 05 00 00 02` for all four. `[8]` is a generic workout
    marker, and the old “walk = `[10]=1`” note is wrong.
  - Data blob: HR samples then HR/pace histogram tables (table values track
    duration/effort, not mode).
- Field notes from the comparison: `[12:16]` is fixed-point steps
  (`value / 256` ≈ step count), `[39]` is the max-speed high byte,
  `[78]` = `items` (sample count), `[84:90]` = three sample-count words,
  and `[71:76]` / `[96:100]` repeat the end date-time.
- Conclusion: the watch does not send the workout mode over BLE in type 04.
  Leave `SPORT_NAMES` empty. VeryFit must use another command or keep the
  mode in its own store.
- Optional low-priority follow-up: capture VeryFit app↔watch traffic while
  opening a workout list, to look for a separate mode field/command.
- Raw captures (gitignored): `captures/workout-2026-11-05-walk.jsonl`,
  `captures/workouts-2026-11-05-strength-run.jsonl`,
  `captures/workout-2026-11-05-walk-short.jsonl`.

## 2. Count-data history — fresh records work; old records do not
- Workouts: five fresh closed records served by type-04 START at offset 0
  (Outdoor Walk `items=58`, Functional Strength `items=4`, Outdoor Run
  `items=3`, short Outdoor Walk `items=3` on 2026-11-05; a 39m16s workout
  `items=39` on 2026-11-06). All decoded and saved.
- Sleep: a fresh night (2026-11-05) was served once on 2026-11-06:
  `items=19`, 426 min, 23:31→06:37, then `items=0`.
- The stream is one-shot/cursor-like: the sync consumed each fresh record;
  the next round returned `items=0`.
- Old sleep/workout/swim records still return `items=0`, and VeryFit shows
  the same gaps. Historical records remain inaccessible.
- Remaining: one fresh swim (type 06) to complete the count-data check.

## 3. Completed-day cursor is one-shot
- After the cursor returns `items=0` it stays spent for the watch's lifetime.
  Disconnect/reconnect, button reboot, `b14=1`, `0x05`, and bare STOP do not
  rewind it (tested 2026-11-05). Factory reset untested (it also empties the
  BLE-accessible store).
- Consequence: completed days can only be captured going forward. Dashboard
  sync drains whatever is queued; the 9-day drain is covered by the mock
  test, not by hardware since the queue was spent.

## 4. Hardware verification pending
- **Completed-day drain ✅ (2026-11-06):** one dashboard Sync pulled the
  completed 2026-11-05 day for every day-data type — sport `items=96`,
  HR `items=507`, SpO2 `items=16`, pressure `items=49` — and each type then
  returned `items=0`. Sleep and workout count-data were also served once.
  Raw log: `captures/sync-2026-11-06-dashboard-log.txt` (gitignored).
- First-run auto-setup and the skew-banner force reload are still
  code/headless tested only; they need a fresh/reset watch or a deliberately
  broken settings file to exercise live.
