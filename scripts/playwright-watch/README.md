# Playwright + real watch (Windows machine, Python Playwright)

Python Playwright is **already installed** on the Windows machine:

- Python: `C:\Users\pedro\AppData\Local\Programs\Python\Python313\python.exe`
- Playwright package: in that Python's `site-packages`
- Browsers: `C:\Users\pedro\AppData\Local\ms-playwright\chromium-1248\`

From WSL you can run the Windows Python directly:

```bash
WINPY=/mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe
$WINPY -c "import playwright; print('ok')"
```

## Why the user must click the device picker

`navigator.bluetooth.requestDevice()` opens a **native Windows dialog**
(not a web page element). Playwright cannot click native dialogs. So:

1. The script opens the webapp in headed Windows Chrome and clicks "Connect".
2. The native Bluetooth picker pops up on the Windows desktop.
3. **YOU click the ID208 watch in the picker.** That is the pairing step.
4. The script takes over: runs the sync, reads the log, saves files.

## Prerequisites

- The webapp must be served on `http://localhost:8080` (from WSL):
  ```bash
  cd /home/pedro/projects/id208-reader/webapp && python3 -m http.server 8080
  ```
  Windows Chrome can reach WSL's localhost via `localhost` (WSL2 forwards it).
- Windows Bluetooth must be ON (Settings > Bluetooth & devices).
- Chrome needs Bluetooth permission: `chrome://settings/content/bluetooth` → allow.

## Run the watch test

```bash
# From the repo root in WSL:
WINPY=/mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe

# Full history sync + sport offset probe:
$WINPY scripts/playwright-watch/watch_test.py

# 7-day daily sync + probe:
$WINPY scripts/playwright-watch/watch_test.py --daily

# Probe only (no sync):
$WINPY scripts/playwright-watch/watch_test.py --probe
```

When the script prints **"CLICK THE ID208 WATCH IN THE PICKER NOW"**,
click the watch in the native Bluetooth dialog on the Windows desktop.

## Output files (in `scripts/playwright-watch/`)

| File | Contents |
|------|----------|
| `connect-log.txt` | Connection handshake log |
| `last-sync-log.txt` | Full sync TX/RX log (all frames) |
| `last-sync.jsonl` | Raw BLE frames as JSONL |
| `probe-log.txt` | Sport offset probe results |

## Troubleshooting

- **"Bluetooth adapter not available"** — Windows Bluetooth is off, or Chrome
  lacks permission. Check `chrome://settings/content/bluetooth`.
- **Picker doesn't appear** — Chrome must be headed (`headless=False`, which
  the script uses). If running from WSL, the window appears on the Windows desktop.
- **Watch not in picker** — put the watch in discoverable mode (hold button).
- **Stale bond (0x0AF1/0x0AF2 missing in log)** — Windows Settings > Bluetooth >
  remove ID208, reboot watch, retry.
- **`localhost:8080` not reachable from Windows Chrome** — WSL2 should forward
  it. If not, use the WSL IP: `hostname -I` in WSL, then
  `--url http://<wsl-ip>:8080/pull.html`.
