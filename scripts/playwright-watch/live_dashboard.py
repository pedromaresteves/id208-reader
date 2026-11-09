#!/usr/bin/env python3
"""
live_dashboard.py — one-click live check for the dashboard sync path.

Opens the webapp in headed Windows Chrome via Python Playwright, clicks the
page's sync button, waits for the user to pick the ID208 in the native
Bluetooth dialog, then records the sync result + IndexedDB store.

The page URL carries `?v=<epoch>`; the page's script loader propagates that
token to every local module, so a persistent Chrome profile cannot serve
stale code.

Run from WSL (the watch must be awake and bonded):

    WINPY=/mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe
    $WINPY scripts/playwright-watch/live_dashboard.py

Outputs (gitignored): scripts/playwright-watch/dashboard-sync-{log.txt,store.json}
"""
import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = HERE
PAIR_TIMEOUT = 300
SYNC_TIMEOUT = 1800

KEYWORDS = [
    "Sync", "sync", "SPORT", "SLEEP", "HR ", "WORKOUT", "SWIM", "SPO2",
    "PRESSURE", "Saved to store", "empty", "phantom", "0x05", "0x0AF",
    "Ready", "Device Selected", "pair=", "GATT", "bound", "stamp",
    "Last sync", "BT error", "not bound",
]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def save_state(page, name):
    log_text = page.evaluate(
        "() => document.getElementById('log')?.textContent || "
        "'(no #log pane on this page)'"
    )
    with open(os.path.join(OUT_DIR, f"{name}-log.txt"), "w", encoding="utf-8") as f:
        f.write(log_text)
    try:
        store = page.evaluate(
            "() => (typeof Store !== 'undefined') ? Store.exportJSON() : ''"
        )
        if store:
            with open(
                os.path.join(OUT_DIR, f"{name}-store.json"), "w", encoding="utf-8"
            ) as f:
                f.write(store)
            log(f"Store dump saved ({store.count(chr(34) + 'type' + chr(34))} records)")
            return store
    except Exception as exc:  # noqa: BLE001 - best-effort diagnostics
        log(f"store dump failed: {exc}")
    return ""


def summarize(store_text):
    if not store_text:
        return
    doc = json.loads(store_text)
    rows = doc.get("rows", [])
    counts = {}
    dates = {}
    for row in rows:
        counts[row["type"]] = counts.get(row["type"], 0) + 1
        if row["type"] == "steps":
            dates[row["date"]] = row["payload"].get("steps")
    log("Store counts: " + json.dumps(counts, sort_keys=True))
    log("Steps days: " + json.dumps(dates, sort_keys=True))
    meta = [r for r in rows if r["type"] == "meta" and r["date"] == "last-sync"]
    if meta:
        log("Last sync: " + json.dumps(meta[-1]["payload"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--page", default="index.html")
    ap.add_argument("--button", default="#btnSync")
    ap.add_argument("--done", default="Sync done")
    ap.add_argument("--base", default="http://localhost:8080")
    ap.add_argument("--timeout", type=int, default=SYNC_TIMEOUT)
    ap.add_argument("--out", default="dashboard-sync")
    args = ap.parse_args()

    epoch = int(time.time())
    url = f"{args.base.rstrip('/')}/{args.page}?v={epoch}"

    log(f"Opening {url} (scripts cache-busted with ?v={epoch})")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        page.on("pageerror", lambda err: log(f"PAGEERROR: {err}"))
        console_lines = []

        def on_console(msg):
            console_lines.append(msg.text)

        page.on("console", on_console)

        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(1000)

        if not page.evaluate("() => !!navigator.bluetooth"):
            log("ERROR: WebBluetooth unavailable. Check Windows Bluetooth + Chrome permission.")
            browser.close()
            return 2

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

        if "patched requestDevice" not in str(paired):
            print()
            print("=" * 64)
            print(f"  ACTION REQUIRED: clicking {args.button} now.")
            print("  A NATIVE Windows Bluetooth picker appears on the desktop.")
            print("  >>> CLICK THE ID208 WATCH IN THE PICKER NOW <<<")
            print("=" * 64)
            print()

        page.click(args.button)
        log(f"Clicked {args.button}; waiting up to {args.timeout}s for '{args.done}'...")

        seen = 0
        deadline = time.time() + args.timeout
        done = False
        while time.time() < deadline:
            text = page.evaluate(
                "() => (document.getElementById('syncLabel')?.textContent || '') + "
                "'\\n' + (document.getElementById('status')?.textContent || '') + "
                "'\\n' + (document.getElementById('storeStatus')?.textContent || '') + "
                "'\\n' + (document.getElementById('lastSync')?.textContent || '') + "
                "'\\n' + (document.getElementById('waterStatus')?.textContent || '') + "
                "'\\n' + (document.getElementById('watchStatus')?.textContent || '')"
            )
            for line in console_lines[seen:]:
                if any(k in line for k in KEYWORDS):
                    log("  | " + line[:240])
            seen = len(console_lines)
            if args.done in text:
                done = True
                break
            if "Sync failed" in text or "Store unavailable" in text or "Failed (" in text:
                log("ERROR status: " + text.replace("\n", " | ")[:500])
                break
            time.sleep(2)

        log("Page status: " + page.evaluate(
            "() => [document.getElementById('syncLabel')?.textContent, "
            "document.getElementById('status')?.textContent, "
            "document.getElementById('storeStatus')?.textContent, "
            "document.getElementById('lastSync')?.textContent, "
            "document.getElementById('waterStatus')?.textContent, "
            "document.getElementById('watchStatus')?.textContent]"
            ".filter(Boolean).join(' | ')"
        ))
        if not done:
            log(f"WARNING: '{args.done}' not seen before timeout.")
        store = save_state(page, args.out)
        summarize(store)
        browser.close()
        return 0 if done else 1


if __name__ == "__main__":
    raise SystemExit(main())
