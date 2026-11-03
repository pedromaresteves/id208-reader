# AI-NOTES.md — Deep protocol & debugging reference for AI agents

Supplementary to AGENTS.md. Read AGENTS.md first.

## v3 health sync — full sequence (VeryFit pattern)

```
1. TX 0x05 sizes query on 0x0AF1 (137B, 7 type+offset records)
2. RX 0x05 reply on 0x0AF2 (u32 total bytes at payload[0:4])
3. For each type (order: 01→02→03→04→06→07→08):
   a. TX 0x05 with that type's offset (primeOffset05) — re-send before each round
   b. TX 0x04 START on 0x0AF6 (19B, same offset as 0x05)
   c. RX 0x04 reply on 0x0AF7 or 0x0AF2 (may be multi-chunk)
   d. TX 0x04 STOP on 0x0AF6
   e. Step offset by headSize+dataSize for next round
```

### 0x04 START reply payload layout (after cmd+seq)
```
[0]    operate (00=START reply, 01=STOP ack)
[1]    dataType
[2]    byte14 (day-data flag)
[3:5]  flags/reserved
[5:7]  itemCount (u16 LE)
[7:9]  headSize (u16 LE)
[9:13] dataSize (u32 LE)
[13]   reserved
[14:14+headSize]     type-specific header
[14+headSize:...]    data items
```

### Per-type header layouts

**Sport (type 08, day-data):** header ≥20B. year u16LE @[1:3], month @[3],
day @[4], steps u32LE @[8:12], kcal u32LE @[12:16], distance u32LE @[16:20].
Items: 10B each (minute offset + values).

**HR (type 03, day-data):** header ≥10B. year u16LE @[0:2], month @[2],
day @[3], startSec u32LE @[4:8], silent @[9], zones @[10:25].
Items: 2B each (deltaMin u8 + bpm u8).

**Sleep (type 07, count-data):** header ≥16B. fallAsleep year u16LE @[2:4],
month @[4], day @[5], hour @[6], min @[7]; getUp year u16LE @[8:10],
month @[10], day @[11], hour @[12], min @[13]; total u16LE @[14],
wake @[16], light @[18], rem @[20], deep @[22].
Items: 2B each (stage u8 + duration u8).

**Workout (type 04, count-data):** header ≥100B. version @[0],
year u16LE @[1:3], month @[3], day @[4], start h/m/s @[5:8],
sportType @[8], duration u32LE @[17:21], kcal u32LE @[21:25],
distance u32LE @[25:29], avgHr @[29], maxHr @[30], minHr @[31].

**Swim (type 06, count-data):** header ≥34B. date y/m/d @[0:4],
start h/m/s @[4:7], stroke @[8], kcal u16LE @[9], distance u16LE @[11],
laps @[15], duration u16LE @[17], swolf @[19], strokes u16LE @[21],
poolLen @[24], pace u16LE @[26], rate u16LE @[28].
Items: 15B per minute.

## saveOffset semantics — what we know

- **0x05 query:** 4-byte LE offset per type. Sets the watch's internal
  resume position. VeryFit sends e.g. sport offset 0x4E=78 in both 0x05
  and 0x04 (see d3nd3/toobur-veryfit-research sync_example.txt).
- **0x04 START:** 16-bit LE offset at bytes 15-16. Must match the 0x05
  offset for that type.
- **Day-data (sport/HR):** offset 0 = today. Byte-step by headSize+dataSize
  to reach previous days. Offsets 0-3 all land inside today's ~1KB record.
- **Count-data (sleep/workouts/swims):** offset 0 = oldest record. The
  watch may use a spent cursor (repeated STARTs return successive records).
  Observed working sleep offsets: 0, 1, 27, 108 (from captures).
- **Empty marker:** items=0 with headSize>0, dataSize=0. Not a real record.

## Bind sequence (no vendor app needed)

1. `04 01 F1 01 01 02 02 01 00` — bind start → reply has challenge[6] + MAC[6]
2. `03 23 02 00` — between bind and auth
3. `04 05 0C 00 + challenge[6] + (challenge XOR MAC)[6]` — auth, finalizes bind
   → reply `04 05 00 00` flips pair 0→1, QR clears
4. Prelude: func table, DND, weather off, goals, units, HR mode, battery,
   user info, set time, info (see `setupAuto` in ble.js, 18 steps)

## Reference repos

- `d3nd3/toobur-veryfit-research` — protocol research, logcat captures,
  LATEST_SYNC_PARSING.md (canonical v3 sync reference)
- `d3nd3/gadgetbridge-veryfit` — Gadgetbridge fork with Toobur driver
  (local clone at `/home/pedro/projects/gadgetbridge-veryfit`)
- `xssfox/idowatch`, `idoosmart/idowatch`, `orangebrush/angelfit` — other
  IDO protocol implementations

## Debugging tips

- The pull page has manual buttons for each step (2-21) plus an offset
  input field. Use these to test individual commands.
- "C. Probe sport offsets" sends sport START at 9 offsets and logs results.
- JSONL download captures all TX/RX frames — share this for debugging.
- If 0x0AF1/0x0AF2 are missing (stale bond), the app falls back to
  0x0AF6/0x0AF7 only. Fix: Android Settings > Bluetooth > Forget ID208,
  reboot watch, reconnect.
- Watch in low-power mode: 0x05 on 0x0AF1 may be silent. The app handles
  this (5s timeout, proceeds to 0x04 anyway).
