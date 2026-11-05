#!/usr/bin/env python3
"""
watch_test.py — Drive the id208-reader webapp from Windows Chrome via
Python Playwright, connect to the REAL ID208 watch over WebBluetooth,
run syncs + the all-types offset probe, and save all logs + the store.

Run from WSL (this sandbox) — it launches the Windows Chrome executable:

    /mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe \
        scripts/playwright-watch/watch_test.py

IMPORTANT: navigator.bluetooth.requestDevice() opens a NATIVE Windows
Bluetooth picker dialog. Playwright CANNOT click native dialogs.
YOU must click the ID208 watch in the picker when prompted.

Usage:
    python watch_test.py              # connect + auto daily sync + full sync + probe + store dump
    python watch_test.py --daily      # connect + auto daily sync + probe only
    python watch_test.py --probe      # connect (no sync buttons) + probe only
    python watch_test.py --no-probe   # connect + syncs, skip the probe
    python watch_test.py --url http://localhost:8080/pull.html
"""
import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = HERE

PAIR_TIMEOUT = 240    # seconds to wait for the user to click the device
READY_TIMEOUT = 60
SYNC_TIMEOUT = 1200   # full sync can page many rounds; each round is a few seconds
PROBE_TIMEOUT = 1200

KEYWORDS = [
    "PROBE", "F1PROBE", "round", "empty", "paging done", "Saved to store", "sync done",
    "daily sync done", "PAGEERROR", "MISSING", "0x05", "sizes reply", "SPORT", "SLEEP", "HR ",
    "WORKOUT", "SWIM", "SPO2", "PRESSURE", "BT error", "Ready", "Device Selected",
    "pair=", "0x0AF", "Notify", "GATT", "bound", "stamp", "Last sync",
]


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# Windows Python defaults to cp1252 stdout; ble.js log lines contain arrows
# and dashes — reconfigure so printing never crashes the run.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def wait_for_log(page, marker, timeout, tag):
    """Poll #log until marker appears; stream new interesting lines as they land."""
    seen = 0
    deadline = time.time() + timeout
    found = False
    while time.time() < deadline:
        try:
            text = page.evaluate("() => document.getElementById('log')?.textContent || ''")
        except Exception:
            text = ""
        lines = text.splitlines()
        for ln in lines[seen:]:
            if any(k in ln for k in KEYWORDS):
                print("  | " + ln[:240], flush=True)
        seen = len(lines)
        if marker and marker in text:
            found = True
            break
        time.sleep(2)
    if not found:
        log(f"WARNING: '{marker}' not seen within {timeout}s ({tag}) — continuing.")
    return found


def save_page_state(page, name):
    """Save log, decoded pane, JSONL frames and the IndexedDB store dump."""
    log_text = page.evaluate("() => document.getElementById('log')?.textContent || ''")
    with open(os.path.join(OUT_DIR, f"{name}-log.txt"), "w", encoding="utf-8") as f:
        f.write(log_text)
    try:
        decoded = page.evaluate("() => document.getElementById('decoded')?.innerHTML || ''")
        with open(os.path.join(OUT_DIR, f"{name}-decoded.html"), "w", encoding="utf-8") as f:
            f.write(decoded)
    except Exception as e:
        log(f"decoded pane save failed: {e}")
    jsonl = page.evaluate(
        "() => (typeof lines !== 'undefined' && lines.length) ? lines.map(l => JSON.stringify(l)).join('\\n') : ''"
    )
    if jsonl:
        with open(os.path.join(OUT_DIR, f"{name}.jsonl"), "w", encoding="utf-8") as f:
            f.write(jsonl + "\n")
        log(f"JSONL saved ({len(jsonl.splitlines())} frames) to {name}.jsonl")
    try:
        store = page.evaluate("() => (typeof Store !== 'undefined') ? Store.exportJSON() : ''")
        if store:
            with open(os.path.join(OUT_DIR, f"{name}-store.json"), "w", encoding="utf-8") as f:
                f.write(store)
            n = store.count('"type"')
            log(f"Store dump saved to {name}-store.json (~{n} records)")
    except Exception as e:
        log(f"store dump failed: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daily", action="store_true", help="skip the full-history sync (auto daily sync still runs after connect)")
    ap.add_argument("--probe", action="store_true", help="probe only, no sync buttons")
    ap.add_argument("--no-probe", action="store_true", help="skip the probe")
    ap.add_argument("--url", default="http://localhost:8080/pull.html")
    args = ap.parse_args()

    log(f"Opening {args.url} in headed Windows Chrome...")
    log("WebBluetooth requires headed mode — the native picker will appear on the Windows desktop.")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                "--enable-features=WebBluetooth",
                "--enable-experimental-web-platform-features",
            ],
        )
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        page.on("pageerror", lambda err: log(f"PAGEERROR: {err}"))

        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_timeout(1000)

        has_bt = page.evaluate("() => !!navigator.bluetooth")
        log(f"navigator.bluetooth available: {has_bt}")
        if not has_bt:
            log("ERROR: WebBluetooth not available. Check Windows Bluetooth is ON and")
            log("  Chrome has Bluetooth permission (chrome://settings/content/bluetooth).")
            log("  Also: the page must be on localhost or https (secure context).")
            browser.close()
            sys.exit(1)

        # If the watch is ALREADY paired at the Windows OS level, skip the
        # native picker entirely: getDevices() returns it and we patch
        # requestDevice() to hand it straight to the webapp.
        paired = page.evaluate(
            """async () => {
                if (!navigator.bluetooth.getDevices) return 'getDevices unsupported';
                const devs = await navigator.bluetooth.getDevices();
                const names = devs.map(d => d.name || '(unnamed)');
                const d = devs.find(d => d.name && /ID208|IDO/i.test(d.name));
                if (!d) return 'no ID208 among paired: ' + names.join(', ');
                window.__pairedDevice = d;
                navigator.bluetooth.requestDevice = () => Promise.resolve(window.__pairedDevice);
                return 'patched requestDevice with paired device: ' + d.name;
            }"""
        )
        log(f"Paired-device check: {paired}")

        # ---- Connect: click the button, then WAIT for user to pick device ----
        if "patched requestDevice" not in str(paired):
            print()
            print("=" * 64)
            print("  ACTION REQUIRED: The script clicks '1. Connect' now.")
            print("  A NATIVE Windows Bluetooth picker appears on the desktop.")
            print("  >>> CLICK THE ID208 WATCH IN THE PICKER NOW <<<")
            print("=" * 64)
            print()
        else:
            log("Using the OS-paired watch directly (no native picker needed).")
            log("If GATT connect fails, wake the watch (tap its screen) so it advertises.")

        page.click("#btnConnect")
        log(f"Clicked Connect. Waiting up to {PAIR_TIMEOUT}s for you to pick the device...")
        ok = wait_for_log(page, "Device Selected", PAIR_TIMEOUT, "pairing")
        if not ok:
            log("TIMEOUT: No device selected. Did you click the ID208 in the native picker?")
            save_page_state(page, "connect")
            browser.close()
            sys.exit(1)
        log("Device selected! Waiting for GATT connect + notify setup...")
        wait_for_log(page, "Ready.", READY_TIMEOUT, "ready")
        save_page_state(page, "connect")
        log("Connect state saved to connect-log.txt / connect.jsonl")

        # ---- Auto daily sync (runs automatically after connect when bound) ----
        if not args.probe:
            log("Waiting for the automatic daily sync after connect (or 'not bound')...")
            wait_for_log(page, "Daily sync done", SYNC_TIMEOUT, "auto daily sync")
            wait_for_log(page, "not bound", 5, "bind check")
            save_page_state(page, "auto-sync")

        # ---- Full history sync ----
        if not args.probe and not args.daily:
            log("Clicking 'B. Sync full history'...")
            page.click("#btnSyncAll")
            wait_for_log(page, "Full sync done", SYNC_TIMEOUT, "full sync")
            save_page_state(page, "full-sync")
            log("Full sync state saved to full-sync-log.txt / full-sync.jsonl / full-sync-store.json")

        # ---- All-types offset probe ----
        if not args.no_probe:
            print()
            print("=" * 64)
            log("Running the ALL-TYPES offset probe (this can take several minutes)...")
            print("=" * 64)
            if "pull.html" not in page.url:
                page.goto(args.url, wait_until="domcontentloaded")
                page.wait_for_timeout(1000)
            page.click("#btnProbe")
            wait_for_log(page, "=== Probe done ===", PROBE_TIMEOUT, "probe")
            save_page_state(page, "probe")
            log("Probe state saved to probe-log.txt / probe.jsonl / probe-store.json")

            log("--- Probe results ---")
            full_log = page.evaluate("() => document.getElementById('log')?.textContent || ''")
            for line in full_log.splitlines():
                if "PROBE RESULT" in line or "0x05 rec" in line or "0x05 reply payload" in line:
                    print("  " + line[:250], flush=True)

        log("")
        log("All done. Outputs in scripts/playwright-watch/:")
        log("  connect-*, auto-sync-*, full-sync-*, probe-*  (each: -log.txt, .jsonl, -store.json, -decoded.html)")
        browser.close()


if __name__ == "__main__":
    main()
