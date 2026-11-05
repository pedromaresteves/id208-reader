# Priority TODO (open items only)

## 1. Workout mode byte — blocked on count-data history
- Known icon→record pairs: 08/10 Functional Strength, 08/10 + 09/10 Outdoor
  Walk. Header byte `[8]` reads 5 on both → not the mode. Byte `[10]` reads
  0 (strength) vs 1 (walk) → lead candidate.
- Hypotheses: (a) `[10]` is the mode enum, or (b) it is an indoor/outdoor
  flag. Official IDO tables have no record-ID mapping.
- Watch displayed four records (strength/walk/run) while type-04 history
  returned `items=0` at offset 0 over BLE. VeryFit has the same gap.
- Next experiment: close nRF, record a 2-minute workout with an explicit
  stop+save, then Full sync → JSONL. If it appears, auto-detected sessions
  are the special case; if still empty, the BLE store is broken watch-side.
- Then pull one Outdoor Run summary + JSONL. A third `[10]` value supports
  (a); another `1` supports (b), and the real mode byte still needs finding.
- No code changes until the bytes speak.

## 2. Count-data history is empty over BLE (sleep 07 / workouts 04 / swims 06)
- `items=0` at offset 0 on this firmware, even when the watch display shows
  data. Count-data paging is now cursor-only (START/STOP at offset 0).
- VeryFit shows the same gap, so this is a watch-side store divergence, not
  a decoder bug. Daily accumulation is the current history source.
- Need: one successful closed-workout capture (see §1) to confirm whether
  the BLE store can ever serve count-data.

## 3. Completed-day cursor is one-shot
- After the cursor returns `items=0` it stays spent for the watch's lifetime.
  Disconnect/reconnect, button reboot, `b14=1`, `0x05`, and bare STOP do not
  rewind it (tested 2026-11-05). Factory reset untested (it also empties the
  BLE-accessible store).
- Consequence: completed days can only be captured going forward. Dashboard
  sync drains whatever is queued; the 9-day drain is covered by the mock
  test, not by hardware since the queue was spent.

## 4. Hardware verification pending
- Once a new completed day exists, run one dashboard Sync to prove the
  completed-day drain on the real watch (the mock test covers 9 days).
- First-run auto-setup and the skew-banner force reload are code/headless
  tested only; they need a fresh/reset watch or a deliberately broken file
  to exercise live.

## 5. Low priority: sleep page partial nights
- `sleep.html` hides `total_min == 0` records. Decide whether to show
  in-progress nights with a clear marker instead.
