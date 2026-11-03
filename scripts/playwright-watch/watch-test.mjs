#!/usr/bin/env node
/**
 * watch-test.mjs — Drive the id208-reader webapp from Playwright on Windows,
 * connect to the REAL watch over WebBluetooth, run a sync, capture logs.
 *
 * IMPORTANT: navigator.bluetooth.requestDevice() opens a NATIVE OS dialog.
 * Playwright cannot click it. YOU must click the ID208 watch in the picker.
 * The script prints a clear prompt and waits up to 120s for you to do it.
 *
 * Usage:
 *   node scripts/playwright-watch/watch-test.mjs            # full sync + probe
 *   node scripts/playwright-watch/watch-test.mjs --daily    # daily sync + probe
 *   node scripts/playwright-watch/watch-test.mjs --probe    # probe only
 *   node scripts/playwright-watch/watch-test.mjs --url http://localhost:8080/pull.html
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;

// Parse args
const args = process.argv.slice(2);
const mode = args.includes('--daily') ? 'daily' : args.includes('--probe') ? 'probe' : 'full';
const urlArg = args.find(a => a.startsWith('--url='));
const URL = urlArg ? urlArg.slice(6) : 'http://localhost:8080/pull.html';

const PAIR_TIMEOUT_MS = 120_000;   // 2 min for the user to click the device
const SYNC_TIMEOUT_MS = 300_000;   // 5 min for the sync to finish
const PROBE_TIMEOUT_MS = 180_000;  // 3 min for the probe

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log(`Opening ${URL} in headed Chrome...`);
  log('WebBluetooth requires headed mode — the native device picker will appear.');

  // Use a persistent context so the Bluetooth pairing survives across runs
  const userDataDir = path.join(OUT_DIR, '.chrome-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--enable-features=WebBluetooth',
      '--enable-experimental-web-platform-features',
    ],
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Capture console logs from the page
  const pageLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    pageLogs.push(text);
  });
  page.on('pageerror', err => {
    pageLogs.push('PAGEERROR: ' + err.message);
    log('PAGEERROR: ' + err.message);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Check WebBluetooth is available
  const hasBT = await page.evaluate(() => !!navigator.bluetooth);
  log(`navigator.bluetooth available: ${hasBT}`);
  if (!hasBT) {
    log('ERROR: WebBluetooth not available. Enable Bluetooth on Windows and');
    log('  allow Bluetooth for localhost in chrome://settings/content/bluetooth');
    await context.close();
    process.exit(1);
  }

  // Click Connect — this triggers requestDevice() → native picker
  log('');
  log('========================================================');
  log('  ACTION REQUIRED: Click "1. Connect" if not auto-clicked.');
  log('  A NATIVE Bluetooth picker will appear.');
  log('  >>> CLICK THE ID208 WATCH IN THE PICKER NOW <<<');
  log('========================================================');
  log('');

  // Click the Connect button
  const btnConnect = await page.$('#btnConnect');
  if (btnConnect) {
    await btnConnect.click();
    log('Clicked Connect. Waiting for you to pick the device in the native dialog...');
  } else {
    log('ERROR: #btnConnect not found. Is the webapp served correctly?');
    await context.close();
    process.exit(1);
  }

  // Wait for the device to be selected (the page logs "Device Selected:")
  log(`Waiting up to ${PAIR_TIMEOUT_MS / 1000}s for device selection...`);
  const paired = await page.waitForFunction(
    () => {
      const logEl = document.getElementById('log');
      return logEl && logEl.textContent.includes('Device Selected');
    },
    { timeout: PAIR_TIMEOUT_MS }
  ).then(() => true).catch(() => false);

  if (!paired) {
    log('TIMEOUT: No device was selected in the native picker.');
    log('Did you click the ID208 watch? If the picker never appeared, check:');
    log('  - Windows Bluetooth is ON (Settings > Bluetooth)');
    log('  - Chrome has Bluetooth permission (chrome://settings/content/bluetooth)');
    log('  - The watch is in range and discoverable');
    await context.close();
    process.exit(1);
  }

  log('Device selected! Waiting for GATT connect + notify setup...');

  // Wait for "Ready." or "Notify ON" in the log
  const ready = await page.waitForFunction(
    () => {
      const logEl = document.getElementById('log');
      if (!logEl) return false;
      const t = logEl.textContent;
      return t.includes('Ready.') || t.includes('Notify ON 0x0AF2') || t.includes('Notify ON 0x0AF7');
    },
    { timeout: 30_000 }
  ).then(() => true).catch(() => false);

  if (!ready) {
    log('WARNING: Did not see "Ready." — checking log so far:');
    const logText = await page.evaluate(() => document.getElementById('log')?.textContent || '');
    log(logText.slice(-500));
  } else {
    log('Watch connected and ready.');
  }

  // Dump the connect log
  const connectLog = await page.evaluate(() => document.getElementById('log')?.textContent || '');
  fs.writeFileSync(path.join(OUT_DIR, 'connect-log.txt'), connectLog);
  log('Connect log saved to scripts/playwright-watch/connect-log.txt');

  // ---- Run sync ----
  if (mode !== 'probe') {
    const btnSync = mode === 'daily'
      ? await page.$('#btnDailyAuto')  // may not exist on pull page; use dashboard
      : await page.$('#btnSyncAll');

    if (btnSync) {
      log(`Clicking sync button (mode=${mode})...`);
      await btnSync.click();
    } else if (mode === 'daily') {
      // pull.html doesn't have btnDailyAuto; navigate to index.html for daily sync
      log('Daily sync button not on pull page — navigating to dashboard...');
      await page.goto(URL.replace('pull.html', 'index.html'), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      const btnSyncDash = await page.$('#btnSync');
      if (btnSyncDash) {
        log('Clicking dashboard sync...');
        await btnSyncDash.click();
      }
    }

    log(`Waiting up to ${SYNC_TIMEOUT_MS / 1000}s for sync to finish...`);
    const syncDone = await page.waitForFunction(
      () => {
        const logEl = document.getElementById('log');
        if (!logEl) return false;
        const t = logEl.textContent;
        return t.includes('Daily pull done') || t.includes('Full pull done') || t.includes('Sync failed');
      },
      { timeout: SYNC_TIMEOUT_MS }
    ).then(() => true).catch(() => false);

    if (syncDone) {
      log('Sync finished.');
    } else {
      log('WARNING: Sync did not report "done" within timeout — saving partial log.');
    }

    // Save the full log
    const syncLog = await page.evaluate(() => document.getElementById('log')?.textContent || '');
    fs.writeFileSync(path.join(OUT_DIR, 'last-sync-log.txt'), syncLog);
    log('Sync log saved to scripts/playwright-watch/last-sync-log.txt');

    // Try to download JSONL via the page's lines array
    const jsonl = await page.evaluate(() => {
      if (typeof lines !== 'undefined' && lines.length) {
        return lines.map(l => JSON.stringify(l)).join('\n');
      }
      return '';
    });
    if (jsonl) {
      fs.writeFileSync(path.join(OUT_DIR, 'last-sync.jsonl'), jsonl + '\n');
      log(`JSONL saved (${jsonl.split('\n').length} frames) to scripts/playwright-watch/last-sync.jsonl`);
    }

    // Print key log lines
    log('--- Key sync log lines ---');
    for (const line of syncLog.split('\n')) {
      if (/PROBE|Sport round|Sleep round|HR round|Workout round|Swim round|SPORT|SLEEP|HR |empty|paging done|Saved to store|pull done|PAGEERROR|0x0AF1 MISSING|0x0AF2 MISSING/.test(line)) {
        console.log('  ' + line.slice(0, 250));
      }
    }
  }

  // ---- Run probe ----
  log('');
  log('========================================================');
  log('  Running sport offset probe...');
  log('========================================================');
  const btnProbe = await page.$('#btnProbe');
  if (btnProbe) {
    // Go back to pull page if we navigated away
    if (!page.url().includes('pull.html')) {
      await page.goto(URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
    }
    await btnProbe.click();
    log(`Waiting up to ${PROBE_TIMEOUT_MS / 1000}s for probe to finish...`);
    const probeDone = await page.waitForFunction(
      () => {
        const logEl = document.getElementById('log');
        return logEl && logEl.textContent.includes('=== Probe done ===');
      },
      { timeout: PROBE_TIMEOUT_MS }
    ).then(() => true).catch(() => false);

    const fullLog = await page.evaluate(() => document.getElementById('log')?.textContent || '');
    fs.writeFileSync(path.join(OUT_DIR, 'probe-log.txt'), fullLog);
    log('Probe log saved to scripts/playwright-watch/probe-log.txt');

    log('--- Probe results ---');
    for (const line of fullLog.split('\n')) {
      if (/PROBE RESULT|Probe sport @byte|SPORT dataType/.test(line)) {
        console.log('  ' + line.slice(0, 250));
      }
    }
    if (!probeDone) log('WARNING: Probe did not finish within timeout.');
  } else {
    log('Probe button not found — is the webapp up to date?');
  }

  log('');
  log('All done. Logs saved in scripts/playwright-watch/');
  log('  - connect-log.txt   (connection handshake)');
  log('  - last-sync-log.txt (full sync TX/RX log)');
  log('  - last-sync.jsonl   (raw frames, if captured)');
  log('  - probe-log.txt     (sport offset probe results)');

  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
