#!/usr/bin/env python3
"""
watch_test.py — Drive the id208-reader webapp from Windows Chrome via
Python Playwright, connect to the REAL ID208 watch over WebBluetooth,
run syncs, and save all logs + the store.

Run from WSL (this sandbox) — it launches the Windows Chrome executable:

    /mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe \
        scripts/playwright-watch/watch_test.py

IMPORTANT: navigator.bluetooth.requestDevice() opens a NATIVE Windows
Bluetooth picker dialog. Playwright CANNOT click native dialogs.
YOU must click the ID208 watch in the picker when prompted.

Usage:
    python watch_test.py              # connect + auto daily sync + full sync + store dump
    python watch_test.py --daily      # connect + auto daily sync only
    python watch_test.py --url http://localhost:8080/diagnostics.html
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

KEYWORDS = [
    "round", "empty", "paging done", "Saved to store", "sync done",
    "daily sync done", "PAGEERROR", "MISSING", "0x05", "SPORT", "SLEEP", "HR ",
    "WORKOUT", "SWIM", "SPO2", "PRESSURE", "BT error", "Ready", "Device Selected",
    "pair=", "0x0AF", "Notify", "GATT", "bound", "stamp", "Last sync",
]


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# Windows Python defaults to cp1252 stdout; module log lines contain arrows
# and dashes — reconfigure so printing never crashes the run.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


_LOG_SEEN = {"n": 0}


def wait_for_log(page, marker, timeout, tag):
    """Poll #log until marker appears; stream only newly landed lines."""
    deadline = time.time() + timeout
    found = False
    while time.time() < deadline:
        try:
            text = page.evaluate("() => document.getElementById('log')?.textContent || ''")
        except Exception:
            text = ""
        lines = text.splitlines()
        if _LOG_SEEN["n"] > len(lines):
            _LOG_SEEN["n"] = 0  # page navigated/reloaded; restart the stream
        for ln in lines[_LOG_SEEN["n"]:]:
            if any(k in ln for k in KEYWORDS):
                print("  | " + ln[:240], flush=True)
        _LOG_SEEN["n"] = len(lines)
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
    ap.add_argument("--daily", action="store_true", help="skip the full sync (auto daily sync still runs after connect)")
    ap.add_argument("--url", default="http://localhost:8080/diagnostics.html")
    args = ap.parse_args()
    # The persistent Chrome profile can cache modules; version the page URL so
    # every local script loads with the same fresh token.
    sep = '&' if '?' in args.url else '?'
    url = f"{args.url}{sep}v={int(time.time())}"

    log(f"Opening {url} in headed Windows Chrome...")
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

        page.goto(url, wait_until="domcontentloaded")
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
        log("Waiting for the automatic daily sync after connect (or 'not bound')...")
        synced = wait_for_log(page, "Daily sync done", SYNC_TIMEOUT, "auto daily sync")
        if not synced:
            wait_for_log(page, "not bound", 5, "bind check")
        save_page_state(page, "auto-sync")

        # ---- Full sync ----
        if not args.daily:
            log("Clicking 'Full sync'...")
            page.click("#btnSyncAll")
            wait_for_log(page, "Full sync done", SYNC_TIMEOUT, "full sync")
            save_page_state(page, "full-sync")
            log("Full sync state saved to full-sync-log.txt / full-sync.jsonl / full-sync-store.json")

        log("")
        log("All done. Outputs in scripts/playwright-watch/:")
        log("  connect-*, auto-sync-*, full-sync-*  (each: -log.txt, .jsonl, -store.json, -decoded.html)")
        browser.close()


if __name__ == "__main__":
    main()
