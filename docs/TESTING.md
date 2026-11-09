# Testing and live hardware playbook

## Test layers

| Layer | What it covers | Command |
|---|---|---|
| pytest | Builders, parsers, capture replay, store/sync helpers, JS↔Python parity | `.venv/bin/python -m pytest tests/ -q` |
| ruff | Lint + formatting | `.venv/bin/ruff check src tests sync.py` |
| Node suites | Codec/capture, charts, store, file-skew, JS parity | `node webapp/<name>.test.js` |
| Headless UI | Page load, nav, skew banner absent + fires on a blocked script, backup/import | `ui_smoke.py` (Windows Python) |
| Live hardware | Real BLE sync, setup, protocol probes | Windows Playwright drivers |

Run everything:

```bash
./scripts/test.sh
```

It runs pytest, ruff check + format check, `node --check` on every webapp
script, then all node suites.

### Fixtures and parity

`tests/fixtures/` is **synthetic only** — never copy real captures or health
samples there.

- `history-5day.jsonl` — synthetic multi-day capture.
- `history-5day.expected.json` — canonical summary used by
  `tests/test_parity.py`.
- `store/` — synthetic records for `webapp/store.test.js`.

Regenerate the expected summary after an intentional decoder change:

```bash
node webapp/parity.test.js --json > tests/fixtures/history-5day.expected.json
```

The same test also compares the JS decode with the Python decode, so an
unmirrored change fails even if the expected file is regenerated.

## Live hardware prerequisites

The Linux sandbox has **no Bluetooth**. Live tests run from WSL against the
Windows machine:

- Windows Python:
  `/mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe`
- Browsers: `/mnt/c/Users/pedro/AppData/Local/ms-playwright/chromium-1248/`
- Windows Bluetooth on, Chrome allowed to use it.
- Watch awake/bonded; VeryFit closed unless you are deliberately testing it.
- Webapp served on `:8080`:

```bash
cd webapp && python3 -m http.server 8080
```

Windows Chrome reaches WSL's localhost via `localhost`. If it does not, use
the WSL IP (`hostname -I`) with `--base`/`--url`.

## Drivers

Run from the repo root in WSL:

```bash
WINPY=/mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe
```

| Driver | Page / action | Outputs (gitignored) |
|---|---|---|
| `watch_test.py` | `diagnostics.html`: Connect (auto-sync) then Full sync | `connect*`, `auto-sync*`, `full-sync*` (JSONL, log, store, decoded HTML) |
| `live_dashboard.py` | `index.html`: one **Sync Data** click | `dashboard-sync-log.txt`, `dashboard-sync-store.json` |
| `ui_smoke.py` | all pages, headless, no Bluetooth | pass/fail only |

Useful flags:

```bash
$WINPY scripts/playwright-watch/watch_test.py --daily
$WINPY scripts/playwright-watch/live_dashboard.py --out my-run
```

### The picker click

`navigator.bluetooth.requestDevice()` opens a **native Windows dialog** that
Playwright cannot click. The driver prints a prompt; **you must click the
ID208 watch**. Leave Chrome open until the driver prints `Sync done` and
closes it.

Closing the window early produces `TargetClosedError` and the run stops.

### Cache busting

Drivers append `?v=<epoch>` and the page loaders propagate it to every local
JS file. Manual live checks should do the same, otherwise a persistent Chrome
profile can serve stale code.

### Profile and log caveats

- Each driver run uses a fresh browser context: the IndexedDB store is
  **ephemeral**. The store JSON dump is the artifact; use backup/import to
  move records.
- The dashboard driver truncates each console line to 240 characters. A logged
  RX frame can therefore look 2 bytes short (the CRC and possibly header tail
  are cut). Trust `len`, `head_size` and `data_size`, not the printed line.
- `watch_test.py` saves full JSONL; `live_dashboard.py` does not.

## Feature captures (swim, workout modes, notifications)

These features need hardware data before any decoding or labelling work can
start. All captures are gitignored; scrub the full Bluetooth MAC (keep the
first three octets) before sharing.

### Swim with laps

Swims are count-data: a fresh record is served once, so pull immediately.

1. Record a pool swim with the pool length set and **more than two laps**.
2. Note the watch summary: duration, distance, laps, kcal, average pace,
   SWOLF, stroke rate, pool length.
3. Right after the swim, run `watch_test.py --daily` and click the watch.
4. Send `auto-sync.jsonl`, `auto-sync-store.json` and the screen numbers.

If the pull still shows `items=0`, the watch does not expose lap data over BLE.

### VeryFit ↔ watch traffic (workout mode, wash-hands reminder)

The saved type-04 record carries no mode byte (the 2026-11-05 capture has
`sport_type: 5` for both strength and run), so mode labels and the missing
reminder toggles can only come from vendor traffic.

1. Android: enable Developer options → **Bluetooth HCI snoop log**, then
   toggle Bluetooth off/on (or reboot) so logging starts.
2. Connect VeryFit and perform each action, noting the time:
   - start/stop three different workout modes (e.g. Strength, Walk, Run);
   - toggle the wash-hands reminder off and on.
3. Pull the log:
   ```bash
   adb root
   adb pull /data/misc/bluetooth/logs/btsnoop_hci.log
   ```
   Some phones use `/sdcard/btsnoop_hci.log` or include it in a bug report.
4. Run one normal `watch_test.py --daily` so the matching BLE summaries exist.
5. Send the HCI log plus the action/time list.

### Drink-water reminder (reference-derived)

`03 60` came from the TOOBUR A200 reference, not the ID208. Toggle it on the
Watch page and confirm the watch reacts; if the schedule bytes are wrong,
capture the VeryFit write with the HCI log above.

Wash hands uses `03 55`, confirmed against the VeryFit Hand washing setting
(2026-11-09: writing OFF flipped it).

## First-run / factory-reset test

Use this only when you need to exercise bind/auth. A reset **empties the
watch's BLE history**, so sync anything important first.

1. Factory reset the watch.
2. Remove **ID208** from Windows Settings → Bluetooth & devices, so Windows
   cannot reuse the old bond.
3. Keep VeryFit closed.
4. Serve the webapp and run `live_dashboard.py`.
5. Click the watch in the picker and leave Chrome open ~2–3 minutes.

Expected log:

```
pair=0
Watch not bound (pair=0) — running first-time setup (bind + auth, ~90 s)
[Setup 1/18] ... [Setup 18/18]
pair=1
Setup complete (pair=1) — starting the first sync
Sync done
```

The same setup is exposed as **Set up watch** on `watch.html` and **Setup
watch** on `diagnostics.html` if the automatic path is not used.

## Manual diagnostics workflow

`diagnostics.html` is the recovery/protocol page:

1. **Connect** — runs the automatic sync (today + completed-day drain).
2. **Full sync** — drains every queued completed day.
3. **Copy log** / **Download JSONL** — capture a trace for analysis.
4. **Sizes query** and the collapsed raw START/STOP controls are for protocol
   experiments only; sync does not use them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Bluetooth adapter not available" | Windows Bluetooth off or Chrome lacks permission (`chrome://settings/content/bluetooth`) |
| Picker does not appear | Driver must be headed; watch awake/discoverable |
| Watch missing from picker | Remove/re-pair in Windows Bluetooth, reboot watch |
| `0x0AF1`/`0x0AF2` missing in log | Stale bond; remove device in Windows, reboot watch, retry |
| `localhost:8080` unreachable from Windows | Use `hostname -I` and pass the WSL IP |
| Driver closes with `TargetClosedError` | Chrome window was closed before `Sync done` |
| Sync finds no history | History cursor may be spent, or the record is old (count-data is one-shot); try Full sync and read `docs/PROTOCOL.md` |

## Reporting results

Say exactly which layer passed:

- "tested with mocks/headless" — code logic only.
- "tested on the watch" — quote the driver log lines (item counts, decoded
  values, `pair=`).
