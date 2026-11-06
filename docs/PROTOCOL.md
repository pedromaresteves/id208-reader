# Protocol and data model

Reverse-engineered notes for the ID208 Plus (IDO/VeryFit dialect, firmware
v1.01.17). Everything here was observed on the wire or against on-screen
numbers; uncertain fields are labelled as such.

Sources: this repo's captures (`captures/`, gitignored), the public projects
`xssfox/idowatch`, `idoosmart/idowatch`, `orangebrush/angelfit` and
`d3nd3/toobur-veryfit-research`.

## GATT

Service `0x0AF0`.

| Characteristic | Direction | Use |
|---|---|---|
| `0x0AF6` | write | Legacy short commands + short v3 frames (including 19-byte START/STOP) |
| `0x0AF7` | notify | Replies for `0x0AF6`, including v3 frames |
| `0x0AF1` | write | Bulk v3 on some watches; **writes are refused on this bond** |
| `0x0AF2` | notify | Bulk v3 replies; listen here too |

Sync uses `0x0AF6` only. The 137-byte `0x05` sizes query remains available as
a manual diagnostics action but is not sent by sync (offsets are ignored on
`0x0AF6` and cost timeout time).

Listen for v3 frames on **both** notify characteristics. Notifications may
split a frame across chunks (MTU-dependent).

## v3 framing

```
33 | DA AD DA AD 01 | len (u16 LE) | cmd (u16 LE) | seq (u16 LE) | payload | crc (u16 LE)
```

- `len` is the declared body length after the leading `0x33`. For the 19-byte
  START/STOP it is 16 (the 2-byte CRC is excluded); the 137-byte sizes query
  (diagnostics only) declares 136. Reassembly stops once this many bytes are
  buffered; the CRC is not validated today.
- CRC is CRC-16-CCITT-FALSE (poly `0x1021`, init `0xFFFF`) over the bytes from
  `DA` through the last payload byte, stored little-endian.
- Multi-chunk reassembly: the first chunk carries the full preamble and
  length; continuation chunks start with `0x33` and continue the body. The
  reassembler strips each chunk's `0x33` and concatenates until `len` bytes
  are present.
- Command values used here: `0x04` health START/STOP, `0x05` sizes, `0x09`
  HR mode, `0x1A` function table.

Logging note: the Playwright dashboard driver truncates each console line to
240 characters. A raw frame in that log can look 2 bytes short — trust the
length field and `head_size`, not the logged line.

## Health common header (cmd `0x04` payload)

14 bytes at the start of every health payload:

| Offset | Size | Field |
|---|---:|---|
| 0 | 1 | operate (`00` START, `01` STOP for replies) |
| 1 | 1 | data_type |
| 2-4 | 3 | zeros (unknown) |
| 5-6 | 2 | item_count (u16 LE) |
| 7-8 | 2 | head_size (u16 LE) |
| 9-12 | 4 | data_size (u32 LE) |
| 13 | 1 | zero |

Then `head_size` bytes of record header, then `data_size` bytes of data.

## START/STOP (19-byte packet on `0x0AF6`)

| Offset | Field |
|---|---|
| 12 | operate: `00` START, `01` STOP |
| 13 | data_type |
| 14 | day-data flag (`01` for 01/02/03/08, `00` for 04/06/07) |
| 15-16 | save offset (u16 LE; ignored on this bond) |

`0x0AF1` refuses the same writes on this watch.

## Data types

| Type | Meaning | History style |
|---:|---|---|
| `01` | SpO2 | day-data |
| `02` | Pressure | day-data |
| `03` | Heart rate | day-data |
| `04` | Workout (details) | count-data |
| `06` | Swim | count-data |
| `07` | Sleep | count-data |
| `08` | Sport (daily totals) | day-data |

### Day-data history (01/02/03/08)

- `b14=1` returns **today** (in progress), without advancing history.
- `b14=0` returns the next **completed** day from a persistent cursor, oldest
  first. One START + matching STOP round = one day.
- STOP must echo the START's `b14`; a `b14=1` STOP does not advance the
  cursor.
- `items=0` ends paging. The cursor is one-shot for the watch's lifetime and
  is not rewound by reconnects, `b14=1`, `0x05` or a bare STOP.
- The watch was factory reset on 2026-11-06; whether the cursor restarts from
  the reset date is first observable on 2026-11-07.

### Count-data history (04/06/07)

- Paged with START/STOP at offset 0.
- A **freshly saved** record is served once, then consumed by the next round.
- Old records return `items=0` even when the watch screen still shows them.
- `items=0` normally means the empty marker (zeroed header). One exception is
  verified: a swim can arrive with `items=0` and a **real** 34-byte header
  (date + duration) — a zero-lap summary. See `swim_summary_has_record`.

## Record layouts

All multi-byte integers are little-endian unless stated.

### Sport / daily totals (08)

Header >= 28 bytes.

| Offset | Field |
|---|---|
| 1-2 | year |
| 3 | month |
| 4 | day |
| 8-11 | total_steps (u32) |
| 12-15 | raw_total_calories (u32) — **not** display kcal |
| 16-19 | total_distance_m (u32) |
| 20-23 | total_active_min (u32, minutes) |
| 26-27 | display_kcal (u16) — matches the watch screen |

### Heart rate day (03)

Header >= 25 bytes for zones.

| Offset | Field |
|---|---|
| 0-1 | year |
| 2 | month |
| 3 | day |
| 4-7 | start seconds since midnight (u32, signed) |
| 9 | silent / resting HR |
| 10-24 | five 3-byte zones (`thr`, `min`, unknown) |
| data | 2-byte samples: `delta_s`, `bpm`; deltas accumulate from start |

`0xFF`/`0x00` fillers are empty slots. Only sampled points exist; min/max on
the watch may come from a fuller internal store.

### Sleep night (07)

Header >= 24 bytes.

| Offset | Field |
|---|---|
| 2-3 | fall-asleep year |
| 4-7 | fall-asleep month/day/hour/min |
| 8-9 | get-up year |
| 10-13 | get-up month/day/hour/min |
| 14-15 | total minutes |
| 16-17 | awake minutes |
| 18-19 | light minutes |
| 20-21 | REM minutes |
| 22-23 | deep minutes |

Totals include awake time (`wake + light + REM + deep == total`). There is no
per-minute stage timeline in this record.

### Swim (06)

34-byte header + 15-byte per-minute items.

| Offset | Field |
|---|---|
| 0-1 | year |
| 2-6 | month, day, hour, min, sec |
| 8 | main stroke (`1` = freestyle) |
| 9-10 | calories (u16) |
| 11-12 | distance_m (u16) |
| 15 | laps (u8) |
| 17-18 | duration_s (u16) |
| 19 | SWOLF |
| 21-22 | strokes (u16) |
| 24 | pool length (m) |
| 26-27 | pace s/100 m (`0xFFFF` = unset) |
| 28-29 | stroke rate spm |

Per-minute item (15 bytes): `[0]` HR bpm, `[1]` stroke, `[4]` rate spm,
`[6:8]` distance that minute, `[10]` minute index. Only the distance sum is
fully anchored (2026-10-14: 66 × 25 m = 1650 m).

Zero-lap sessions (fake/short swims) arrive with `items=0`, no data, and a
real header. An all-zero header is the empty marker.

### Workout details (04)

100-byte header.

| Offset | Field |
|---|---|
| 0 | version (`16`) |
| 1-2 | year |
| 3-7 | month, day, hour, min, sec |
| 8 | generic workout marker (`5` on every observed mode) |
| 17-20 | duration_s (u32) |
| 21-24 | calories (u32) |
| 25-28 | distance_m (u32) |
| 29 / 30 / 31 | avg / max / min HR |
| 32 / 33 | avg / max cadence |
| 34 / 35 | avg / max stride |
| 36-37 | avg speed (u16, /100 km/h) |
| 38-39 | max speed (u16, /100 km/h) |
| 40-41 | avg pace (s) |
| 42-43 | fast pace (s) |
| 71-76 | end date/time |
| 78 | item/sample count |
| 84-89 | three sample-count words |
| 96-99 | end month/day/hour/min (repeat) |

Data blob: HR bpm samples at ~5 s intervals starting at `data[0]`. Leading
`0x00` bytes are missing samples (not a prefix); the run ends at the first
`0x00`. If header HR stats are all zero, no samples are read (the following
histogram tables can look like bpm). After the separator come HR/pace/cadence
segment tables.

**The workout mode is not exposed** in this record. `[8]` reads 5 for
Functional Strength, Outdoor Walk and Outdoor Run; `[10]` (once believed to be
the mode) is 0 for all of them. `[12:16]` behaves like fixed-point steps
(`value / 256` ≈ steps) but is unconfirmed; `[48:56]` and the tail tables are
still partial.

### SpO2 (01) and pressure (02)

| Offset | Field |
|---|---|
| 0-1 | year |
| 2 | month |
| 3 | day |
| 4-7 | start seconds since midnight (u32) |
| data | 2-byte samples: `delta_s`, value |

SpO2 values are filtered to 50-100. Pressure is kept raw (0-100 in observed
data); units/calibration are not confirmed. These types are decoded by the
webapp only; `sync.py` does not emit them.

## Builders, parsers and parity

`webapp/codec.js` and `src/ido/decoder.py` must stay byte-identical for
builders and behaviorally identical for parsers. Guarded by
`tests/test_decoder.py`, `webapp/capture.test.js`, `tests/test_parity.py` and
`webapp/parity.test.js`.

| Purpose | JS | Python |
|---|---|---|
| v3 START/STOP | `buildV3Start04` / `buildV3Stop04` | `build_v3_start_04` / `build_v3_stop_04` |
| Sizes query | manual diagnostics | `build_v3_sizes_05` |
| Bind/auth | `buildBindStart`, `buildBindAuthPacket` | `build_bind_start`, `build_bind_auth` |
| Setup prelude | builders in codec.js | `build_set_time`, goals, units, user info, HR mode, weather off |
| Decode health | `decodeHealth` | `parse_v3_health_common` + per-type parsers |
| Zero-lap swim | `swimHeaderHasRecord` | `swim_summary_has_record` |

## Store schema

IndexedDB database `id208-reader`, version 1, object store `records`.
Key path `[date, type]`; index `by-type-date` on `[type, date]`.

One record per `(date, type)`, so newer pulls overwrite the same key instead
of duplicating history.

| Type | Key date | Payload |
|---|---|---|
| `steps` | `YYYY-MM-DD` | steps, distance_m, kcal, active_min, source |
| `sleep` | night date | night, fall_asleep, get_up, total_min, wake_min, light_min, rem_min, deep_min, source |
| `hr` | `YYYY-MM-DD` | start_time_s, silent_hr, zones, samples `[{t, bpm}]`, source |
| `workout` | `date + ' ' + startS` | workout or swim fields + samples |
| `spo2` | `YYYY-MM-DD` | startS, items, samples `[{t, value}]`, headHex, dataHex |
| `pressure` | `YYYY-MM-DD` | same shape as SpO2 |
| `meta` | `last-sync` | day, at, tag |

Backups are JSON `{app: 'id208-reader', version: 1, rows: [...]}`. Import
accepts a store backup, the combined offline JSON, or `steps.csv`.

## Known limitations

- **Factory reset empties the BLE-accessible store.** The watch UI can still
  show older data from a separate store that BLE cannot read. VeryFit has the
  same gap.
- **Completed-day cursor is one-shot.** After `items=0`, only new completed
  days can be captured. Post-reset behavior is first checked on 2026-11-07.
- **Count-data is one-shot.** Fresh sleep/workout/swim records are served
  once; old records return `items=0`.
- **Workout mode is unavailable** in type-04 data.
- **Bulk characteristic unusable on this bond** (`0x0AF1` writes refused).
- **Sleep is totals only**; `sleep.html` marks in-progress nights best-effort
  (zero totals or a future get-up) because the watch sends no flag.
- **SpO2/pressure units unconfirmed.**

## Evidence timeline

- **2026-09-29** — first transport via Android Chrome; basic-info layout.
- **2026-10-01** — screen ground truth: 5736 steps, 468 kcal, 425 min sleep.
- **2026-10-03** — live 10065 steps / 7641 m / 631 kcal; sport header layout;
  sleep paging (425 min night).
- **2026-10-06** — post-reset bind attempts; bind needs `04 01` + `04 05`
  auth, not just the prelude.
- **2026-10-08** — bind bypass proven; first workouts (strength 15:28, walk
  18:21).
- **2026-10-11** — workout history returns `items=0` despite on-screen
  records; BLE store diverges from the UI store.
- **2026-10-14** — pool-swim anchor: 2409 s, 1650 m, 66 laps, 358 kcal,
  48 spm, SWOLF 113.
- **2026-11-03/04** — 137-byte sizes proof; day cursor behavior.
- **2026-11-05** — STOP must echo `b14`; four workouts captured; count-data
  served once; `[10]` mode theory disproved.
- **2026-11-06** — completed-day drain verified (sport 96 / HR 507 / SpO2 16
  / pressure 49); fresh sleep 426 min; 39m16s workout; zero-lap swim
  captured; HR samples fixed to start at `data[0]`; factory reset +
  first-run setup verified; sleep page redesigned.

## Open questions

- Post-reset completed-day cursor: check the 2026-11-07 sync.
- Swim with real laps: validate the per-minute data path live (the Oct 14
  anchor exists, but no live pull has shown `items>0` for swim yet).
- Workout mode: only recoverable from VeryFit app↔watch traffic, if at all.
- Workout header leftovers: `[12:16]` steps hypothesis, `[48:56]`, segment
  tables.
- SpO2 and pressure: units and calibration against the watch screen.
- Skew banner: only exercised by a partial file update; no live/headless test
  yet.
