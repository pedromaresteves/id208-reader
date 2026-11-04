#!/usr/bin/env python3
"""
phone_adb_probe.py — Drive the id208-reader webapp in the PHONE's Chrome over
plain ADB (no CDP needed: Chrome 156 on Android ignores --remote-debugging-port).

Flow:
  1. adb reverse tcp:8080 tcp:8080  (phone localhost:8080 -> WSL webapp server)
  2. open http://localhost:8080/pull.html in phone Chrome
  3. tap "1. Connect"  ->  the phone's NATIVE Bluetooth picker appears;
     THE USER taps the ID208 watch there (adb/uiautomator cannot click it)
  4. wait for "Ready." in the page log
  5. if the log says "not bound", tap "A. Setup watch" (re-binds to the phone;
     the watch may currently be bound to the Windows PC) and wait "Setup done"
  6. tap "D. Probe history via 0x0AF1" and stream F1PROBE lines until
     "=== F1PROBE done ==="
  7. tap "Download JSONL" and "Export store backup", then adb pull them from
     /sdcard/Download into this directory, plus the full page log

Requires: adb with the phone connected (`adb devices` shows it, e.g. after
`adb pair`/`adb connect` wireless debugging), webapp served on :8080 in WSL.

Usage:  python3 scripts/playwright-watch/phone_adb_probe.py [--skip-probe]
"""
import argparse
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "http://localhost:8080/pull.html"
PAIR_TIMEOUT = 300
READY_TIMEOUT = 120
SETUP_TIMEOUT = 300
PROBE_TIMEOUT = 1200


def adb(*args, timeout=30):
    return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def ui_dump():
    """Return (xml_text, {button_text: (cx, cy)}) from a fresh uiautomator dump."""
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    r = adb("pull", "/sdcard/ui.xml", os.path.join("/tmp/opencode", "ui.xml"))
    if r.returncode != 0:
        return "", {}
    try:
        xml = open("/tmp/opencode/ui.xml", encoding="utf-8", errors="replace").read()
    except FileNotFoundError:
        return "", {}
    buttons = {}
    for m in re.finditer(
        r'<node[^>]*text="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml
    ):
        t, x1, y1, x2, y2 = m.groups()
        buttons[t] = ((int(x1) + int(x2)) // 2, (int(y1) + int(y2)) // 2)
    return xml, buttons


def page_log_text(xml):
    """All text nodes of the page (the #log div content shows up here)."""
    return "\n".join(re.findall(r'text="([^"]*)"', xml))


def tap(cx, cy):
    adb("shell", "input", "tap", str(cx), str(cy))


def find_button(buttons, *needles):
    for t, pos in buttons.items():
        if all(n.lower() in t.lower() for n in needles):
            return t, pos
    return None, None


def wait_for(marker, timeout, tag, stream_keywords=("F1PROBE", "PROBE", "pair=", "not bound", "BT error", "Ready", "Device Selected", "Setup done", "PAGEERROR", "macro is already", "Daily pull done")):
    """Poll the page log until `marker` appears; stream interesting lines."""
    seen = set()
    deadline = time.time() + timeout
    found = False
    while time.time() < deadline:
        xml, buttons = ui_dump()
        text = page_log_text(xml)
        for ln in text.splitlines():
            if ln and ln not in seen:
                seen.add(ln)
                if any(k in ln for k in stream_keywords):
                    print("  | " + ln[:240], flush=True)
        if marker and marker in text:
            found = True
            break
        time.sleep(3)
    if not found:
        log(f"WARNING: '{marker}' not seen within {timeout}s ({tag}) — continuing.")
    return found, buttons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-probe", action="store_true", help="connect + setup only, don't run probe D")
    ap.add_argument("--reuse", action="store_true",
                    help="assume phone Chrome is already on pull.html and connected; skip open/Connect, "
                         "wait for the auto-sync to finish, then run probe D")
    args = ap.parse_args()

    devs = adb("devices").stdout
    log("adb devices:\n" + devs)
    if "device" not in devs.splitlines()[-1] and not any(l.strip().endswith("device") for l in devs.splitlines()[1:]):
        log("ERROR: no adb device — run adb pair/adb connect first.")
        sys.exit(1)

    r = adb("reverse", "tcp:8080", "tcp:8080")
    log(f"adb reverse 8080: {r.stdout.strip() or r.stderr.strip()}")
    log(adb("reverse", "--list").stdout.strip())

    if args.reuse:
        log("--reuse: assuming phone Chrome is already on pull.html and connected.")
    else:
        log(f"Opening {URL} in phone Chrome...")
        adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", URL,
            "-n", "com.android.chrome/com.google.android.apps.chrome.Main")
        # Poll for the page to render (Chrome cold start can take >10s).
        t, pos = None, None
        for _ in range(30):
            time.sleep(2)
            xml, buttons = ui_dump()
            t, pos = find_button(buttons, "1. Connect")
            if pos:
                break
        if not pos:
            log("ERROR: Connect button not found on screen. Is the page loaded?")
            sys.exit(1)
        log(f"Tapping '{t}' at {pos}")
        tap(*pos)
        print()
        print("=" * 64)
        print("  ACTION REQUIRED ON THE PHONE: the native Bluetooth picker is open.")
        print("  >>> TAP THE ID208 WATCH IN THE PICKER <<<")
        print("=" * 64)
        print()
        wait_for("Device Selected", PAIR_TIMEOUT, "pairing")
        wait_for("Ready.", READY_TIMEOUT, "ready")

    # Bind check: if not bound, run setup macro A (watch may be bound to the
    # Windows PC after the 2026-11-04 bind test).
    xml, buttons = ui_dump()
    text = page_log_text(xml)
    if "not bound" in text and "pair=1" not in text:
        log("Watch not bound to the phone — opening Setup section and running 'A. Setup watch'...")
        t, pos = find_button(buttons, "Setup & advanced")
        if pos:
            tap(*pos)
            time.sleep(1)
        xml, buttons = ui_dump()
        t, pos = find_button(buttons, "A. Setup watch")
        if pos:
            log(f"Tapping '{t}' at {pos}")
            tap(*pos)
            wait_for("Setup done", SETUP_TIMEOUT, "setup")
        else:
            log("Setup button not found — continuing anyway.")
    else:
        log("Watch appears bound (pair=1) — skipping setup macro.")

    # The connect auto-sync (dailyAuto) runs as a macro and blocks probe D
    # (macroRunning guard) — wait for it to finish before tapping D.
    log("Waiting for the post-connect auto-sync ('Daily pull done') before probing...")
    wait_for("Daily pull done", 900, "auto daily sync")
    wait_for("not bound", 5, "bind check")

    # Save state after connect/setup.
    xml, _ = ui_dump()
    with open(os.path.join(HERE, "phone-connect-log.txt"), "w", encoding="utf-8") as f:
        f.write(page_log_text(xml))
    log("Saved phone-connect-log.txt")

    if args.skip_probe:
        log("--skip-probe: done.")
        return

    # Tap "D. Probe history via 0x0AF1".
    xml, buttons = ui_dump()
    t, pos = find_button(buttons, "D. Probe history")
    if not pos:
        log("ERROR: probe D button not found — is the page still on pull.html?")
        sys.exit(1)
    log(f"Tapping '{t}' at {pos} — probe runs a few minutes...")
    tap(*pos)
    print("=" * 64)
    log("Probe D running — streaming F1PROBE lines from the page log...")
    print("=" * 64)
    wait_for("=== F1PROBE done ===", PROBE_TIMEOUT, "probe F1")

    # Final log + artifacts.
    xml, buttons = ui_dump()
    text = page_log_text(xml)
    with open(os.path.join(HERE, "phone-probe-log.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    log("Saved phone-probe-log.txt")
    for ln in text.splitlines():
        if "F1PROBE" in ln or "SPORT dataType" in ln or "HR " in ln:
            print("  " + ln[:250], flush=True)

    # Download JSONL + store backup via the page buttons, then pull from phone.
    for needle, out in (("Download JSONL", "phone-probe.jsonl"), ("Export store backup", "phone-probe-store.json")):
        xml, buttons = ui_dump()
        t, pos = find_button(buttons, needle)
        if pos:
            log(f"Tapping '{t}' to download artifact...")
            tap(*pos)
            time.sleep(4)
    dl = adb("shell", "ls", "-t", "/sdcard/Download").stdout.split()
    log(f"/sdcard/Download newest: {dl[:6]}")
    for name in dl[:8]:
        if name.endswith((".jsonl", ".json")):
            safe = name.replace("(", "_").replace(")", "_")
            r = adb("pull", f"/sdcard/Download/{name}", os.path.join(HERE, safe))
            log(f"Pulled {name} -> {safe} ({'ok' if r.returncode == 0 else r.stderr.strip()})")
    log("Done. Artifacts in scripts/playwright-watch/: phone-connect-log.txt, phone-probe-log.txt, Download pulls.")


if __name__ == "__main__":
    main()
