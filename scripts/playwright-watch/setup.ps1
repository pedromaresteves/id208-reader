# Playwright watch test — Windows setup (PowerShell)
#
# Run these commands in PowerShell on the Windows machine:
#
#   # 1. Install Node.js 18+ from https://nodejs.org if not present
#   node --version
#
#   # 2. Copy the id208-reader repo to the Windows machine, then:
#   cd id208-reader
#   npm init -y
#   npm install playwright
#   npx playwright install chromium
#
#   # 3. Serve the webapp (keep this terminal open):
#   cd webapp
#   python -m http.server 8080
#
#   # 4. In a NEW terminal, run the watch test:
#   cd id208-reader
#   node scripts/playwright-watch/watch-test.mjs
#
#   # When the native Bluetooth picker appears, CLICK THE ID208 WATCH.
#   # Playwright cannot click native dialogs — you must do this step.
#
# Options:
#   node scripts/playwright-watch/watch-test.mjs --daily    # 7-day sync
#   node scripts/playwright-watch/watch-test.mjs --probe    # probe only
#   node scripts/playwright-watch/watch-test.mjs --url http://localhost:8080/pull.html
