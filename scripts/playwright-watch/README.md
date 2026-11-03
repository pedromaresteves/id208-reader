# Playwright + real watch on Windows

Goal: drive the webapp from a Windows machine with Playwright, connect to the
real ID208 watch over WebBluetooth, run a sync, and capture the full TX/RX log.

## Why the user must click the device picker

`navigator.bluetooth.requestDevice()` opens a **native OS dialog** (not a web
page element). Playwright cannot click native dialogs. So the flow is:

1. Playwright opens the webapp in headed Chrome and clicks "Connect".
2. The native Bluetooth picker pops up.
3. **YOU click the ID208 watch in the picker.** That is the pairing step.
4. Playwright takes over: runs the sync, reads the log, saves JSONL.

## Setup (Windows PowerShell)

```powershell
# 1. Install Node.js 18+ from https://nodejs.org (if not already)
node --version

# 2. Clone/copy this repo to the Windows machine, then:
cd id208-reader

# 3. Install Playwright + Chromium
npm init -y
npm install playwright
npx playwright install chromium

# 4. Serve the webapp locally (keep this terminal open)
cd webapp
python -m http.server 8080
# → http://localhost:8080
```

## Run the watch test

```powershell
# From the repo root (webapp must be served on :8080)
node scripts/playwright-watch/watch-test.mjs
```

The script will:
1. Open `http://localhost:8080/pull.html` in headed Chrome.
2. Print: **"Click the ID208 in the Bluetooth picker now."**
3. Wait for the device to be selected (up to 120 s).
4. Once connected, click **"B. Sync full history"** (or pass `--daily` for
   the 7-day sync).
5. Wait for the sync to finish (watches for "done" in the log).
6. Save the full log to `scripts/playwright-watch/last-sync-log.txt` and
   the JSONL to `scripts/playwright-watch/last-sync.jsonl`.
7. Also run the **"C. Probe sport offsets"** and save its output.

## Usage

```powershell
node scripts/playwright-watch/watch-test.mjs            # full history sync + probe
node scripts/playwright-watch/watch-test.mjs --daily    # 7-day daily sync + probe
node scripts/playwright-watch/watch-test.mjs --probe    # probe only, no sync
node scripts/playwright-watch/watch-test.mjs --url http://localhost:8080/pull.html
```

## Troubleshooting

- **"Bluetooth adapter not available"** — Chrome needs Bluetooth enabled on
  Windows (Settings > Bluetooth). Also try launching Chrome with
  `--enable-features=WebBluetooth` (the script adds this flag).
- **Picker doesn't appear** — make sure Chrome is headed (not headless).
  The script uses `headless: false`.
- **Watch not in picker** — put the watch in pairing/discoverable mode
  (hold the button until it vibrates, or check watch settings).
- **"NotFoundError" after picking** — the watch may have disconnected.
  Click Connect again and re-pick.
- **Stale bond (0x0AF1/0x0AF2 missing)** — Windows Settings > Bluetooth >
  remove the ID208, reboot the watch, retry.
- **Permission denied** — Chrome needs Bluetooth permission:
  `chrome://settings/content/bluetooth` → allow localhost.
