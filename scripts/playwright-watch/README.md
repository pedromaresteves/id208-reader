# Playwright live drivers (Windows)

These scripts drive the real watch from WSL using **Windows Python** and its
installed Playwright/Chromium. Full procedures, troubleshooting and the
first-run test are in [`docs/TESTING.md`](../../docs/TESTING.md).

Prerequisites:

- Windows Bluetooth on; Chrome allowed to use it.
- Watch awake and bonded.
- Webapp served from WSL:

```bash
cd webapp && python3 -m http.server 8080
```

Run:

```bash
WINPY=/mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe

$WINPY scripts/playwright-watch/watch_test.py           # diagnostics: connect + full sync
$WINPY scripts/playwright-watch/watch_test.py --daily   # connect only (auto-sync)
$WINPY scripts/playwright-watch/live_dashboard.py       # one dashboard Sync click
$WINPY scripts/playwright-watch/ui_smoke.py             # headless, no Bluetooth
```

## The picker

`requestDevice()` opens a **native Windows Bluetooth dialog**. Playwright
cannot click it. When the script prints the prompt, click **ID208 Plus** and
leave Chrome open until the run finishes.

## Outputs (gitignored)

| Driver | Files |
|---|---|
| `watch_test.py` | `connect*`, `auto-sync*`, `full-sync*` (JSONL + log + store + decoded HTML) |
| `live_dashboard.py` | `dashboard-sync-log.txt`, `dashboard-sync-store.json` |
| `ui_smoke.py` | none |

Notes:

- Every run uses a fresh browser context, so the IndexedDB store is
  ephemeral; the store JSON is the artifact.
- Drivers cache-bust with `?v=<epoch>` and propagate it to every local JS
  file.
- `live_dashboard.py` truncates console lines at 240 characters; a printed
  RX frame can look 2 bytes short. Trust the frame length and `head_size`.
- `watch_test.py` writes full JSONL; `live_dashboard.py` does not.
