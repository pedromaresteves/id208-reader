#!/usr/bin/env python3
"""
ui_smoke.py — headless browser smoke test for the P4 dashboard/settings UX.

No Bluetooth: this only checks that every page loads with cache-busted scripts,
the skew banner stays away, the dashboard shows last-sync + store summary, and
backup/import round-trips the store. It then blocks one module to prove the
skew banner actually fires and halts page wiring. Run from WSL with Windows
Python:

    /mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe \
        scripts/playwright-watch/ui_smoke.py
"""
import json
import os
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8080"
PAGES = ["index.html", "activity.html", "sleep.html", "health.html", "workout.html", "watch.html", "diagnostics.html"]
IMPORT_PATH = os.path.join(tempfile.gettempdir(), "id208-ui-smoke-import.json")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def fixture():
    rows = [
        ("2026-11-01", "steps", {"date": "2026-11-01", "steps": 4321, "distance_m": 3000, "kcal": 210}),
        ("2026-11-01", "sleep", {"night": "2026-11-01", "total_min": 420, "light_min": 200, "deep_min": 80, "rem_min": 140}),
        ("2026-11-01", "hr", {"date": "2026-11-01", "start_time_s": 42, "silent_hr": 60, "samples": [{"t": 42, "bpm": 70}]}),
        ("2026-11-01 0", "workout", {"date": "2026-11-01", "durationsS": 600, "kcal": 50, "samples": [70, 80]}),
        ("2026-11-01", "spo2", {"date": "2026-11-01", "items": 1, "samples": [{"tMin": 1, "value": 97}]}),
        ("2026-11-01", "pressure", {"date": "2026-11-01", "items": 1, "samples": [{"tMin": 1, "value": 30}]}),
        ("last-sync", "meta", {"day": "2026-11-01", "at": "2026-11-01T20:00:00.000Z", "tag": "ui-smoke"}),
    ]
    doc = {
        "app": "id208-reader",
        "version": 1,
        "rows": [
            {"date": d, "type": t, "payload": p, "source": "ui-smoke"} for d, t, p in rows
        ],
    }
    with open(IMPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(doc, f)


def check_skew_banner(browser, epoch):
    """The fail-fast guard must fire when a module is genuinely missing."""
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    # Block one module so IDO.transport is undefined, like a partial update.
    page.route("**/transport.js*", lambda route: route.abort())
    page.goto(f"{BASE}/index.html?v={epoch}", wait_until="load")
    page.wait_for_timeout(600)
    body = page.inner_text("body")
    failures = []
    if "App files out of sync" not in body:
        failures.append("skew: banner did not fire for a blocked transport.js")
    if "IDO.transport" not in body:
        failures.append("skew: banner does not name the missing module")
    if not any("halt:" in e for e in errors):
        failures.append("skew: page did not halt after the banner: " + str(errors))
    if page.get_by_role("button", name="Force reload (fresh files)").count() != 1:
        failures.append("skew: banner has no force-reload button")
    context.close()
    if failures:
        for f in failures:
            log("FAIL: " + f)
    else:
        log("skew firing: banner shown, page halted, reload button present")
    return failures


def main():
    fixture()
    epoch = int(time.time())
    failures = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda err: errors.append(str(err)))

            for name in PAGES:
                page.goto(f"{BASE}/{name}?v={epoch}", wait_until="load")
                page.wait_for_timeout(600)
                body = page.evaluate("() => document.body.innerText")
                if "App files out of sync" in body:
                    failures.append(f"{name}: skew banner visible")
                if errors:
                    failures.append(f"{name}: page errors {errors}")
                    errors.clear()
                nav_count = page.evaluate(
                    "() => document.querySelectorAll('nav.tabs a').length"
                )
                if nav_count != 7:
                    failures.append(f"{name}: nav rendered {nav_count} links")
                current_link = page.evaluate(
                    "() => document.querySelector('nav.tabs a[aria-current]')?.textContent || ''"
                )
                if not current_link:
                    failures.append(f"{name}: nav has no current page")
                scripts = page.evaluate(
                    "() => performance.getEntriesByType('resource')"
                    ".map(r => r.name).filter(n => n.endsWith('.js') || n.includes('.js?'))"
                )
                bad = [s for s in scripts if "?v=" not in s]
                if bad:
                    failures.append(f"{name}: scripts without ?v=: {bad}")
                log(f"{name}: loaded ({len(scripts)} cache-busted scripts)")

            # Dashboard: last-sync line, store summary, backup + import.
            page.goto(f"{BASE}/index.html?v={epoch}", wait_until="load")
            page.wait_for_timeout(600)
            page.set_input_files("#fileImport", IMPORT_PATH)
            page.wait_for_function(
                "() => document.getElementById('status').textContent.includes('Imported')"
            )
            page.wait_for_function(
                "() => document.getElementById('lastSync').textContent.includes('2026-11-01')",
                timeout=5000,
            )
            last_sync = page.inner_text("#lastSync")
            store_status = page.inner_text("#storeStatus")
            log("last-sync: " + last_sync)
            log("store summary: " + store_status)
            if "2026-11-01" not in last_sync:
                failures.append("dashboard: last-sync line did not update")
            if "1 step days, 1 nights, 1 HR days, 1 workouts" not in store_status:
                failures.append("dashboard: store summary unexpected: " + store_status)

            try:
                with page.expect_download(timeout=10000) as download_info:
                    page.click("#btnBackup")
                download = download_info.value
                log("backup download: " + download.suggested_filename)
            except Exception as exc:  # noqa: BLE001 - report, keep checking
                failures.append("dashboard: backup download failed: " + str(exc))

            # Settings page: the first-run/setup and backup controls exist.
            page.goto(f"{BASE}/watch.html?v={epoch}", wait_until="load")
            page.wait_for_timeout(400)
            for selector in ("#btnSetup", "#btnBackup", "#fileImport", "#btnAutoOff", "#goalSteps"):
                if page.locator(selector).count() != 1:
                    failures.append(f"settings: missing {selector}")
            log("settings: setup/backup/goals controls present")

            # Health page: the imported SpO2/stress readings render.
            page.goto(f"{BASE}/health.html?v={epoch}", wait_until="load")
            page.wait_for_timeout(400)
            spo2_text = page.inner_text("#spo2Latest")
            stress_text = page.inner_text("#stressLatest")
            if "97" not in spo2_text:
                failures.append("health: SpO2 reading not rendered: " + spo2_text)
            if "30" not in stress_text:
                failures.append("health: stress reading not rendered: " + stress_text)
            log("health: latest SpO2/stress rendered")

            failures.extend(check_skew_banner(browser, epoch))

            if errors:
                failures.append("final page errors: " + str(errors))
            browser.close()
    finally:
        try:
            os.remove(IMPORT_PATH)
        except OSError:
            pass

    if failures:
        for f in failures:
            log("FAIL: " + f)
        return 1
    log("ui_smoke.py: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
