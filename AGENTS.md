# AGENTS.md — id208-reader

## What this project is

Local, no-account BLE reader for the ID208 Plus smartwatch (IDO/VeryFit
protocol, service `0x0AF0`). A static webapp (`webapp/`) talks to the watch
over WebBluetooth from the phone's Chrome; a Python decoder (`src/ido/`)
replays captured JSONL offline. No vendor app, no cloud, no build step.

Success rule: **numbers decoded by the app must match the watch screen.**
Mismatches are decoder bugs, not cosmetic issues.

## Repo layout

```
├── webapp/              Static webapp (HTML + JS, no build step)
│   ├── index.html       Dashboard (sync, last-sync, store summary, backup)
│   ├── activity.html    Steps/activity history
│   ├── sleep.html       Last night + week chart + month history list
│   ├── workout.html     Workouts and swims
│   ├── watch.html       Watch settings (setup, auto-detect, goals, backup)
│   ├── diagnostics.html Recovery + raw protocol work (connect, full sync, raw)
│   ├── shell.js         DOM log/show, progress, skew guard, nav, store status
│   ├── store.js         IndexedDB wrapper + saveCaptured
│   ├── codec.js         v3 builders + pure decodeHealth() -> typed records
│   ├── transport.js     GATT connect/write/notify + v3 reassembly
│   ├── sync.js          capture state + pullToday/pageDayHistory/syncNow/setup
│   ├── ui.js            Shared charts, formatting, dates, backup, sleep helpers
│   └── *.test.js        Node suites (capture, chart, skew, store, parity)
├── src/ido/
│   ├── decoder.py       Python builders/parsers — must mirror codec.js
│   └── captures.py      JSONL reassembly + collect_health
├── sync.py              Offline decode entry point (captures/ → out/)
├── tests/               pytest suite
│   └── fixtures/        Synthetic golden capture + store fixtures (committed)
├── scripts/test.sh      pytest + ruff + node syntax + node suites
├── scripts/playwright-watch/  Windows Playwright live drivers
├── docs/PROTOCOL.md     Wire format, record layouts, store schema, evidence
├── docs/TESTING.md      Test layers + live hardware playbook
├── captures/            Raw JSONL/logs/photos (gitignored, never commit)
└── out/                 Decoded output (gitignored)
```

## Commands

```bash
# Everything (Python tests + lint + node syntax + node suites)
./scripts/test.sh

# Focused Python
.venv/bin/python -m pytest tests/ -q
.venv/bin/ruff check src tests sync.py
.venv/bin/ruff format --check src tests sync.py

# Focused JS (no deps)
node webapp/capture.test.js
node webapp/chart.test.js
node webapp/skew.test.js
node webapp/store.test.js
node webapp/parity.test.js

# Offline decode
python sync.py

# Serve the webapp
cd webapp && python3 -m http.server 8080
# -> http://localhost:8080/index.html
```

## Conventions

- **JS and Python builders must stay byte-identical.** Change a builder in
  `webapp/codec.js` and mirror it in `src/ido/decoder.py` (and vice versa).
  `tests/test_decoder.py` and `webapp/capture.test.js` guard the vectors.
- **Parsers must agree too.** The webapp (`codec.js`) and offline decoder
  (`captures.py` + `decoder.py`) must turn the same bytes into the same
  records; `tests/test_parity.py` + `webapp/parity.test.js` cover the golden
  capture.
- **No build step, no npm deps** for the webapp. Plain HTML/JS files.
- **Update docs when behavior changes.** Wire facts go in
  `docs/PROTOCOL.md`; test procedures in `docs/TESTING.md`; user-facing
  limits in `README.md`.
- **Never commit** `captures/*.jsonl`, `captures/*.jpeg`, `captures/*.txt`,
  `out/`, `*.log`, `scripts/playwright-watch/*.jsonl`, `*-log.txt`,
  `*-store.json` or `*-decoded.html`. Scrub Bluetooth MACs (keep the first
  three octets) if sharing captures.
- **PLAN*.md files are gitignored** — working notes, not committed docs.

## Critical protocol summary

Full details, offsets and the evidence trail: `docs/PROTOCOL.md`.

- Service `0x0AF0`. `0x0AF6` write / `0x0AF7` notify for legacy commands and
  short v3 frames; `0x0AF1`/`0x0AF2` are the bulk pair. On this bond, writes
  to `0x0AF1` are refused, so sync uses `0x0AF6` only. Listen on both
  notifies.
- v3 frame: `33 DA AD DA AD 01` + declared body length (after the `0x33`;
  16 for the 19-byte START/STOP, 136 for the 137-byte sizes query) + cmd +
  seq + payload + CRC-16-CCITT-FALSE. Multi-chunk frames reassemble by
  length; only the first chunk has the full preamble.
- Health common header (14 bytes): operate, data_type, zeros, item_count
  u16, head_size u16, data_size u32, zero. Then `head_size` bytes of header
  and `data_size` bytes of data.
- `0x04` START/STOP is 19 bytes: byte12 operate, byte13 data_type, byte14
  day-data flag, bytes15-16 save offset (ignored on `0x0AF6`).
- Day-data types (01 SpO2, 02 pressure, 03 HR, 08 sport): `b14=1` returns
  today; `b14=0` advances a persistent completed-day cursor, oldest first,
  one day per round. STOP must echo the START's `b14`. `items=0` ends paging.
- Count-data types (04 workout, 06 swim, 07 sleep): fresh saved records are
  served once at offset 0; old records return `items=0`. Treat the stream as
  one-shot.
- A swim `items=0` reply is not always a marker: an all-zero 34-byte header
  is, but a real date + duration is a zero-lap swim summary. See
  `swim_summary_has_record` / `swimHeaderHasRecord`.
- Workout type-04 HR samples start at `data[0]`; leading `0x00` bytes are
  missing samples, and the run ends at the first `0x00`. The workout mode is
  not exposed in the record.

## Environment constraints — READ BEFORE TESTING

- **This sandbox has NO Bluetooth hardware.** WebBluetooth `requestDevice`
  fails with "Bluetooth adapter not available". You cannot connect to a real
  watch from here.
- **Never present mocked BLE results as hardware behavior.** If asked, say
  plainly: "I can't connect to Bluetooth from here. I can verify logic with
  mocks, or you can run the live drivers on the Windows machine."
- **Live path: Windows Python Playwright via WSL.**
  - Windows Python:
    `/mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe`
  - Browsers: `/mnt/c/Users/pedro/AppData/Local/ms-playwright/chromium-1248/`
  - Serve `webapp/` on `:8080` first, then run a driver from
    `scripts/playwright-watch/`.
  - The native Windows Bluetooth picker cannot be clicked by Playwright —
    **the user must click the watch**. Drivers print a clear prompt.
  - `ui_smoke.py` is headless and needs no Bluetooth.
- Live checks must cache-bust with `?v=<epoch>`; the page loaders propagate it
  to every local JS file. The drivers do this automatically.
- Full live procedures, driver outputs and troubleshooting:
  `docs/TESTING.md`.

## Debugging workflow

1. Read `docs/PROTOCOL.md` for the type you are touching and its known limits.
2. Check `captures/` for real traces (gitignored; may not exist in a fresh
   clone). `captures/README.md` is the local session notebook.
3. Reproduce offline first: `sync.py` or the pytest/node suites.
4. On the phone/PC, use **Full sync** on `diagnostics.html` to drain queued
   days, and **Copy log** / **Download JSONL** to capture a trace.
5. Run `./scripts/test.sh` after any code change.
6. For hardware claims, run a live driver and quote its log; otherwise call
   the result a mock/headless check.

## Git workflow — READ BEFORE COMMITTING

- **Do NOT commit unless the user explicitly asks.** Make the changes, run
  the tests, report what changed, then wait.
- "Commit" / "add and commit" authorizes that change set only. Never push
  unless asked.

## Communication style

- **Ask, don't improvise.** For ambiguous or high-impact changes, propose the
  approach and wait.
- Be upfront about limitations (no Bluetooth, no network, missing tools)
  immediately rather than silently working around them.
- Distinguish "tested with mocks" from "tested on the watch" every time.
- Keep replies short; no filler and no restating what the user already knows.
