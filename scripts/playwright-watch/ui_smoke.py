#!/usr/bin/env python3
"""
ui_smoke.py — headless responsive UI, navigation, and store smoke test.

No Bluetooth: this only checks that every page loads with cache-busted scripts,
the skew banner stays away, the dashboard shows last-sync + store summary, and
backup/import round-trips the store. It then blocks one module to prove the
skew banner actually fires and halts page wiring. Run from WSL with Windows
Python:

    /mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe \
        scripts/playwright-watch/ui_smoke.py
"""
import datetime
import json
import os
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8080"
PAGES = ["index.html", "activity.html", "sleep.html", "health.html", "workout.html", "watch.html", "diagnostics.html"]
IMPORT_PATH = os.path.join(tempfile.gettempdir(), "id208-ui-smoke-import.json")
SCREENSHOT_DIR = os.path.join(tempfile.gettempdir(), "id208-ui-smoke-screenshots")


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


def visual_fixture():
    """Recent multi-day records for chart/card screenshots; mock data only."""
    today = datetime.date.today()
    rows = []
    for ago in range(6, -1, -1):
        day = today - datetime.timedelta(days=ago)
        ds = day.isoformat()
        rows.extend([
            {"date": ds, "type": "steps", "payload": {
                "date": ds, "steps": 4200 + (6 - ago) * 650, "distance_m": 3200 + (6 - ago) * 400,
                "kcal": 240 + (6 - ago) * 35,
            }},
            {"date": ds, "type": "hr", "payload": {
                "date": ds, "silent_hr": 59, "samples": [
                    {"t": 100, "bpm": 62 + ago}, {"t": 600, "bpm": 82 + ago}, {"t": 1100, "bpm": 71 + ago},
                ],
            }},
            {"date": ds, "type": "sleep", "payload": {
                "night": ds, "fall_asleep": f"{day.year}-{day.month}-{day.day - 1 if day.day > 1 else day.day} 23:10",
                "get_up": f"{day.year}-{day.month}-{day.day} 06:35", "total_min": 420 + ago * 4,
                "light_min": 220, "deep_min": 75, "rem_min": 105, "wake_min": 20,
            }},
            {"date": ds, "type": "spo2", "payload": {
                "date": ds, "items": 3, "samples": [
                    {"tMin": 425, "value": 96 + (ago % 3)}, {"tMin": 780, "value": 98}, {"tMin": 1260, "value": 97},
                ],
            }},
            {"date": ds, "type": "pressure", "payload": {
                "date": ds, "items": 3, "samples": [
                    {"tMin": 430, "value": 31 + ago}, {"tMin": 800, "value": 38}, {"tMin": 1210, "value": 28 + ago},
                ],
            }},
        ])
    rows.extend([
        {"date": f"{today.isoformat()} 28800", "type": "workout", "payload": {
            "date": today.isoformat(), "startS": 28800, "durationsS": 1800, "kcal": 180,
            "distanceM": 3200, "avgHr": 132, "maxHr": 158, "minHr": 88,
            "samples": [{"t": 28800 + i * 300, "bpm": 110 + (i % 5) * 8} for i in range(6)],
        }},
        {"date": f"{today.isoformat()} 54000", "type": "workout", "payload": {
            "kind": "swim", "date": today.isoformat(), "startS": 54000, "durationsS": 609,
            "kcal": 0, "distanceM": 0, "avgHr": 0, "maxHr": 0, "minHr": 0,
            "laps": 0, "poolLengthM": 25, "strokes": 0, "swolf": 0, "samples": [],
        }},
        {"date": "goals", "type": "settings", "payload": {"steps": 8000, "kcal": 500}},
    ])
    return rows


def check_visual_accessibility(page, name, width):
    """Check compact viewport overflow, common target sizes, and text contrast."""
    if width in (320, 390):
        overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
        if overflow > 1:
            return [f"{name}: horizontal overflow at {width}px ({overflow}px)"]

    too_small = page.evaluate("""() => {
      const selector = 'nav.tabs a, nav.tabs button, button, a.btn, a.go, a.chip, label.btn, label.chip, .day-row, .workout-card, .nightrow, .heatmap-day, .pager button';
      return [...document.querySelectorAll(selector)].filter((el) => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return false;
        return r.height < 44 || r.width < 44;
      }).map((el) => `${el.id || el.tagName.toLowerCase()}.${String(el.className).replace(/\\s+/g, '.')}: ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
    }""")
    failures = [f"{name}: touch target under 44px: {target}" for target in too_small]

    contrast = page.evaluate("""() => {
      function rgb(value) {
        const m = value.match(/[\\d.]+/g);
        if (!m || m.length < 3) return null;
        const channels = m.slice(0, 3).map(Number);
        return value.startsWith('color(srgb') ? channels.map((v) => v * 255) : channels;
      }
      function luminance(color) {
        const c = color.map((v) => {
          const x = v / 255;
          return x <= .04045 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4);
        });
        return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
      }
      function background(el) {
        let node = el;
        while (node) {
          const color = getComputedStyle(node).backgroundColor;
          if (color && color !== 'transparent' && !color.endsWith(', 0)')) return rgb(color);
          node = node.parentElement;
        }
        return rgb(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
      }
      const selector = 'h1, h2, h3, p, button, a, .muted, .chip, .stat-label, .stat-value, .rating, td, th, summary';
      return [...document.querySelectorAll(selector)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width && r.height && getComputedStyle(el).display !== 'none';
      }).map((el) => {
        const fg = rgb(getComputedStyle(el).color), bg = background(el);
        if (!fg || !bg) return null;
        const a = luminance(fg), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        return ratio < 4.5 ? { text: (el.innerText || el.textContent || '').trim().slice(0, 32), ratio: ratio.toFixed(2), fg, bg } : null;
      }).filter(Boolean);
    }""")
    failures.extend(f"{name}: contrast below 4.5:1 {item}" for item in contrast)
    return failures


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
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
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
            for selector in ("#btnSetup", "#btnBackup", "#fileImport", "#btnAutoOff", "#goalSteps",
                             "#btnWaterOn", "#btnWaterOff", "#btnWashOn", "#btnWashOff"):
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

            # Add a clearly synthetic seven-day dataset for responsive and
            # dark-mode screenshots. These are UI fixtures, never hardware data.
            page.evaluate("""async (rows) => {
              for (const row of rows) await Store.put(row.date, row.type, row.payload, 'ui-smoke visual fixture');
            }""", visual_fixture())
            screenshot_failures = []
            for name in PAGES:
                for mode in ("light", "dark"):
                    page.emulate_media(color_scheme=mode)
                    for width, height in ((390, 844), (1280, 900)):
                        page.set_viewport_size({"width": width, "height": height})
                        page.goto(f"{BASE}/{name}?v={epoch}", wait_until="load")
                        page.wait_for_timeout(450)
                        body = page.evaluate("() => document.body.innerText")
                        if "App files out of sync" in body:
                            screenshot_failures.append(f"{name}: skew banner in {mode} {width}px render")
                        screenshot_failures.extend(check_visual_accessibility(page, name, width))
                        image = os.path.join(SCREENSHOT_DIR, f"{name[:-5]}-{width}-{mode}.png")
                        page.screenshot(path=image, animations="disabled")
                        if errors:
                            screenshot_failures.append(f"{name}: page errors in {mode} {width}px render {errors}")
                            errors.clear()
            failures.extend(screenshot_failures)
            log("responsive screenshots: " + SCREENSHOT_DIR)

            page.set_viewport_size({"width": 320, "height": 844})
            page.goto(f"{BASE}/sleep.html?v={epoch}", wait_until="load")
            page.wait_for_timeout(300)
            failures.extend(check_visual_accessibility(page, "sleep-min-width", 320))

            page.goto(f"{BASE}/activity.html?v={epoch}", wait_until="load")
            page.locator(".day-row[data-date]").nth(1).click()
            if page.inner_text("#heroDate") == datetime.date.today().isoformat():
                failures.append("activity: selecting a day did not update the hero date")

            page.goto(f"{BASE}/health.html?v={epoch}", wait_until="load")
            page.locator("#dayList .day-row[data-date]").nth(1).click()
            if page.inner_text("#spo2Date").strip(" ·") == datetime.date.today().isoformat():
                failures.append("health: selecting a history row did not update the selected day")

            page.goto(f"{BASE}/sleep.html?v={epoch}", wait_until="load")
            page.locator("#monthHeatmap .heatmap-day:not([data-level='0'])").first.click()
            if "7h" not in page.inner_text("#nightDetail"):
                failures.append("sleep: selecting a calendar night did not update the detail")

            page.goto(f"{BASE}/workout.html?v={epoch}", wait_until="load")
            page.locator("#secList .workout-card").nth(1).click()
            if "30m0s" not in page.inner_text("#workoutDetail"):
                failures.append("workouts: selecting a card did not update the detail")

            # More exposes the three secondary destinations without crowding
            # the five always-visible bottom tabs.
            page.emulate_media(color_scheme="light")
            page.set_viewport_size({"width": 390, "height": 844})
            page.goto(f"{BASE}/index.html?v={epoch}", wait_until="load")
            page.click("nav.tabs .more-trigger")
            if page.get_attribute("nav.tabs .more-trigger", "aria-expanded") != "true":
                failures.append("navigation: More did not open")
            if page.locator("nav.tabs .more-menu a:visible").count() != 3:
                failures.append("navigation: More does not show Workouts, Watch, and Diagnostics")
            page.click("nav.tabs .more-menu a[href='workout.html']")
            if page.locator("nav.tabs a[aria-current='page']").get_attribute("href") != "workout.html":
                failures.append("navigation: More workout destination is not active")
            log("navigation: More menu opens and routes to Workouts")

            # Settings: the clear-store action empties the DB after confirming.
            page.on("dialog", lambda dialog: dialog.accept())
            page.goto(f"{BASE}/watch.html?v={epoch}", wait_until="load")
            page.wait_for_timeout(300)
            page.click("#btnClear")
            page.wait_for_timeout(600)
            clear_text = page.inner_text("#clearStatus").lower()
            if "deleted" not in clear_text:
                failures.append("settings: clear-store status: " + clear_text)
            left = page.evaluate(
                "async () => (await Store.list('steps')).length"
                " + (await Store.list('sleep')).length"
            )
            if left:
                failures.append(f"settings: clear-store left {left} record(s)")
            log("settings: clear-store emptied the store")

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
