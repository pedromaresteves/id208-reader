# id208-reader

Local, no-account reader for the ID208 Plus smartwatch (IDO/VeryFit BLE
dialect). Pull steps, sleep, heart rate, SpO2, pressure and workouts over
WebBluetooth into a dashboard that lives entirely in your browser. No vendor
app, no account, no cloud.

Confirmed on **ID208 Plus, firmware v1.01.17**. Other IDO/VeryFit variants may
work if they expose the same `0x0AF0` service — captures and on-screen numbers
are welcome.

Live app (GitHub Pages):
[`webapp/`](https://pedromaresteves.github.io/id208-reader/webapp/) —
[dashboard](https://pedromaresteves.github.io/id208-reader/webapp/index.html),
[diagnostics](https://pedromaresteves.github.io/id208-reader/webapp/diagnostics.html)
for setup and recovery.

## What you get

| Page | Contents |
|---|---|
| **Dashboard** | One-button sync, last-sync stamp, store summary, backup/import |
| **Activity** | Daily steps, distance, calories, goal markers, HR summary |
| **Sleep** | Last-night card, week chart with arrows, month history list, stage split and quality rating; in-progress nights are marked |
| **Health** | SpO2 and stress: latest reading, day chart, 30-day trend, history list |
| **Workouts** | Workouts and pool swims with duration, distance, HR and samples |
| **Watch** | First-run setup, auto-detect toggles, drink-water reminder, goals, backup/import, delete local data |
| **Diagnostics** | Connect, full sync, raw commands, JSONL/log export |

Everything is a plain static file: no build step, no npm dependencies, no
network calls.

## Normal use (phone)

1. Open `index.html` and tap **Sync Data**.
2. The app connects, sets the watch clock, pulls today, and drains every
   completed day the watch has queued.
3. A fresh or factory-reset watch is bound automatically on the first sync
   (`pair=0` → 18-step setup → sync). The same setup is available as
   **Set up watch** on the Watch page.
4. History pages and charts update. Use **Backup store** / **Import backup**
   on the Dashboard or Watch page to move data between browsers.

The store lives only in this browser profile (IndexedDB). It is not uploaded
anywhere.

## Offline decode (PC, optional)

Copy a JSONL capture into `captures/` and run:

```bash
python sync.py
```

It replays captures through `src/ido/` into dated `out/` files
(`steps.csv`, `sleep.json`, `hr.json`, `spo2.json`, `pressure.json`,
`workouts.json`). Captures and `out/` are gitignored.

## Requirements

- Python 3.10+; decoding is stdlib-only.
- Node 18+ for the webapp tests.
- `bleak` is optional, only for a best-effort BLE scan
  (`pip install -e ".[ble]"`; skipped cleanly without an adapter).
- Dev: `pytest`, `ruff` (`pip install -e ".[dev]"`).

## Tests

```bash
./scripts/test.sh     # pytest + ruff + node syntax + every node suite
```

Individual pieces and the live hardware workflow are in
[`docs/TESTING.md`](docs/TESTING.md).

## Privacy

`captures/` (raw JSONL and photos), `out/` and live-driver logs are gitignored
and never committed. If you share a capture for debugging, scrub the full
Bluetooth MAC (keep the first three octets) and never include wrist photos.

## Known limitations

These are watch or firmware limits, not missing UI:

- **Factory reset empties the BLE-accessible history.** The watch display may
  still show old data from a separate UI store that BLE cannot read. VeryFit
  has the same gap.
- **Completed-day history is a one-shot cursor.** Once it returns `items=0`,
  only new completed days can be captured. The cursor is not rewound by
  reconnects or a reset of the app; a watch factory reset starts a fresh store
  and cursor.
- **Count-data (sleep, workouts, swims) is served once.** A freshly saved
  record can be pulled immediately; older records return `items=0` even when
  the watch screen shows them. Daily accumulation is the fallback.
- **Workout mode is not exposed** in the type-04 record. The app cannot label
  Strength / Walk / Run from BLE data; the mode byte is not in the header,
  common header or data blob. It exists only in the live session
  (`10 01` start / `0x13` progress), which a sync-only reader never sees —
  workouts show as "Workout".
- **Sleep is totals only** (bedtime, wake time, stage minutes). There is no
  per-minute stage timeline in the BLE record.
- **SpO2 and "pressure" are confirmed**: SpO2 is percent; type 02 is the
  watch's Stress score (0-100), not blood pressure. Both matched the screen
  on 2026-11-07.
- **Per-app notifications are filtered by VeryFit on the phone**, not by the
  watch. Toggling Calendar, email, SMS, missed calls, WhatsApp, Messenger or
  YouTube sends nothing over BLE; the watch just displays what it receives.

## Status (verified on hardware)

- Steps/distance/calories and daily HR from today + completed-day history.
- Sleep nights, workouts and pool swims (including zero-lap summaries).
- Completed-day drain for a finished day (2026-11-06).
- First-run bind/auth after a factory reset (2026-11-06).
- Workout HR samples from byte 0 of the data blob.
- First post-reset completed day (2026-11-06) drained on 2026-11-07.
- SpO2 (98%) and stress (34) matched the watch screen; type 02 is the
  stress index, and its time axis is minutes since midnight.
- Drink-water reminder prompts inside the 09:00–18:00 window (2026-11-10).
- Not yet observed live: a swim with lap data.

## Roadmap

Still open; the protocol unknowns are tracked in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md#open-questions):

- **Swim lap detail** — the saved summary decodes, but no live pull has ever
  returned `items>0` (per-minute laps), so the lap path is unvalidated.

Already available: walk/run auto-detect prompts (**Watch → Auto-detect**,
`03 49`), auto-pause/end reminders via the same packet, drink-water reminders,
wash-hands reminders (`03 55`), daily goals, backup/import and
delete-local-data.

## Protocol

Summary: service `0x0AF0`; `0x0AF6`/`0x0AF7` carry short v3 frames (including
19-byte `0x04` START/STOP), `0x0AF1`/`0x0AF2` are the bulk pair (writes are
refused on this bond). Day-data types use a completed-day cursor; count-data
types are one-shot. CRC is CRC-16-CCITT-FALSE.

Full wire format, record layouts, store schema and the dated evidence trail:
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

References: `xssfox/idowatch`, `idoosmart/idowatch`,
`orangebrush/angelfit`, `d3nd3/toobur-veryfit-research`.

Reverse-engineered, unofficial, no affiliation. Works without the vendor app
today; a firmware update could change the wire format.
