#!/usr/bin/env python3
"""
watch_diag.py — Live-link diagnostics against the REAL ID208 watch from headed
Windows Chrome, without changing the webapp: everything is driven through the
page's own globals (ble.js top-level functions are window properties).

Phases (all logged into #log, saved as diag-log.txt / diag.jsonl):
  PH0  introspection: char properties, available write methods, 02 01 info
  PH1  0x0AF1 write-variant matrix (writeValue / writeValueWithResponse /
       writeValueWithoutResponse) with the 137B 0x05 all-zero query; RX delta
       after each (does anything answer on 0x0AF2/0x0AF7?)
  PH2  per-type NONZERO-offset 0x05 prime sent on 0x0AF6 via writeValue (the
       channel that DID answer for the all-zero query), then 0x04 START at the
       same offset on 0x0AF6 — the path never actually tested before, because
       primeOffset05's writeValueWithoutResponse on 0x0AF1 "succeeds" silently
       and blocks the 0x0AF6 fallback
  PH3  0x04 START (19B) sent on 0x0AF1 itself
  PH4  sport START sweep on 0x0AF6 with NO 0x05 prime at all
  --bind  between PH4 and PH5: bind/auth from Windows (04 01 -> 03 23 ->
       04 05 -> 02 01), then PH5 re-runs the PH1 matrix + one PH2 round to
       see if app-level bind makes 0x0AF1 writable

Run from WSL:
    /mnt/c/Users/pedro/AppData/Local/Programs/Python/Python313/python.exe \
        scripts/playwright-watch/watch_diag.py [--bind]

Uses a PERSISTENT Chrome profile (%LOCALAPPDATA%\\Temp\\id208-bt-profile), so the
WebBluetooth device grant survives across launches: the native picker appears
only on the first run — click the ID208 once; later runs go through
getDevices() and need no picker. Keep the browser open while a run is active.
"""
import argparse
import os
import sys
import time

from playwright.sync_api import sync_playwright

from watch_test import wait_for_log, save_page_state, log, KEYWORDS

HERE = os.path.dirname(os.path.abspath(__file__))

PAIR_TIMEOUT = 240
READY_TIMEOUT = 60
DIAG_TIMEOUT = 900  # the JS evaluate below runs this long in the worst case

# The whole diagnostic as one async page function. Uses only ble.js globals.
DIAG_JS = r"""
async (doBind, mode) => {
  const L = (m) => log(m);
  try {
    L('=== DIAG start ===');
    L('device=' + (device && device.name) + ' gatt.connected=' + (device && device.gatt.connected));
    L('props 0x0AF6=' + JSON.stringify(writeChar.properties) + ' 0x0AF7=' + JSON.stringify(notifyChar.properties));
    L('props 0x0AF1=' + JSON.stringify(healthWriteChar && healthWriteChar.properties) +
      ' 0x0AF2=' + JSON.stringify(healthNotifyChar && healthNotifyChar.properties));
    L('methods 0x0AF1: writeValue=' + typeof healthWriteChar.writeValue +
      ' wVR=' + typeof healthWriteChar.writeValueWithResponse +
      ' woR=' + typeof healthWriteChar.writeValueWithoutResponse);
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
    await wait(2500);

    async function tryWrite(ch, name, pkt, variant) {
      if (!ch) { L('DIAG ' + name + ' ' + variant + ': NO CHAR'); return false; }
      record(name, 'TX', pkt);
      try {
        if (variant === 'writeValue') await ch.writeValue(pkt);
        else if (variant === 'wVR') await ch.writeValueWithResponse(pkt);
        else await ch.writeValueWithoutResponse(pkt);
        L('DIAG ' + name + ' ' + variant + ': OK');
        return true;
      } catch (e) { L('DIAG ' + name + ' ' + variant + ': FAIL ' + e); return false; }
    }

    async function ph1Matrix(tag) {
      L('=== ' + tag + ': 0x0AF1 write variants (0x05 137B all-zero) ===');
      for (const v of ['writeValue', 'wVR', 'woR']) {
        const before = lines.length;
        await tryWrite(healthWriteChar, '0x0AF1', buildV3Sizes05(), v);
        await wait(2500);
        L('DIAG ' + tag + ' ' + v + ' RXdelta=' + (lines.length - before));
      }
    }

    async function roundF6(type, off, tag) {
      setItems(type, -1); setRec(type, 0); lastSizesTotal = -1;
      const map = {}; map[type] = off;
      const okP = await tryWrite(writeChar, '0x0AF6', buildV3Sizes05(map), 'writeValue');
      if (okP) await waitFor(() => lastSizesTotal >= 0, 5000, 'prime t' + type + '@' + off);
      L('DIAG ' + tag + ' prime t' + type + '@' + off + ' ok=' + okP + ' sizesTotal=' + lastSizesTotal);
      await tryWrite(writeChar, '0x0AF6', buildV3Start04(type, off), 'writeValue');
      await waitFor(() => getItems(type) >= 0, 12000, 'start t' + type + '@' + off);
      L('DIAG RESULT ' + tag + ' t=' + type + ' @' + off + ': items=' + getItems(type) + ' recSize=' + getRec(type));
      await tryWrite(writeChar, '0x0AF6', buildV3Stop04(type), 'writeValue');
      await wait(1500);
    }

    async function startB14(type, off, b14, tag) {
      setItems(type, -1); setRec(type, 0);
      let pkt = new Uint8Array(buildV3Start04(type, off));
      pkt[14] = b14;
      const crc = crc16Ccitt(pkt, 1, pkt.length - 3);
      pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
      await tryWrite(writeChar, '0x0AF6', pkt, 'writeValue');
      await waitFor(() => getItems(type) >= 0, 8000, tag + ' t' + type + '@' + off);
      L('DIAG ' + tag + ' t=' + type + ' b14=' + b14 + ' @' + off + ': items=' + getItems(type) + ' recSize=' + getRec(type));
      await tryWrite(writeChar, '0x0AF6', buildV3Stop04(type), 'writeValue');
      await wait(900);
    }
    async function primeF6(type, off, tag) {
      lastSizesTotal = -1;
      const map = {}; map[type] = off;
      const ok = await tryWrite(writeChar, '0x0AF6', buildV3Sizes05(map), 'writeValue');
      if (ok) await waitFor(() => lastSizesTotal >= 0, 4000, tag + ' prime t' + type + '@' + off);
      L('DIAG ' + tag + ' prime t=' + type + '@' + off + ' ok=' + ok + ' sizesTotal=' + lastSizesTotal);
    }
    async function ph7() {
      L('=== PH7: page history with byte14=0x00, offsets stepped by recSize ===');
      for (let o = 0; o <= 18000; o += 996) await startB14(8, o, 0, 'PH7');   // sport b14=0 recSize=996
      for (let o = 0; o <= 18000; o += 2213) await startB14(3, o, 0, 'PH7');  // HR b14=0 recSize=2213
      await startB14(1, 0, 0, 'PH7');                                          // SpO2 in b14=0 mode
      await startB14(2, 0, 0, 'PH7');                                          // pressure in b14=0 mode
      await startB14(7, 0, 1, 'PH7'); await startB14(4, 0, 1, 'PH7'); await startB14(6, 0, 1, 'PH7'); // count-data with b14=1
    }
    async function ph8() {
      L('=== PH8: how to page the b14=0 history stream (all on 0x0AF6) ===');
      L('--- A: 0x05 prime on 0x0AF6, then b14=0 @0 — does the prime pick the record? ---');
      for (const x of [996, 1992, 8964]) { await primeF6(8, x, 'PH8A'); await startB14(8, 0, 0, 'PH8A'); }
      L('--- B: b14=0 at small offsets 1..8 (record-index hypothesis) ---');
      for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) await startB14(8, o, 0, 'PH8B');
      L('--- C: 5x consecutive START b14=0 @0 with NO STOP between (cursor?) ---');
      for (let k = 0; k < 5; k++) {
        setItems(8, -1); setRec(8, 0);
        let pkt = new Uint8Array(buildV3Start04(8, 0)); pkt[14] = 0;
        const crc = crc16Ccitt(pkt, 1, pkt.length - 3);
        pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
        await tryWrite(writeChar, '0x0AF6', pkt, 'writeValue');
        await waitFor(() => getItems(8) >= 0, 8000, 'ph8c' + k);
        L('DIAG PH8C start#' + k + ' @0 b14=0: items=' + getItems(8) + ' recSize=' + getRec(8));
        await wait(1200);
      }
      await tryWrite(writeChar, '0x0AF6', buildV3Stop04(8), 'writeValue');
      await wait(900);
      L('--- D: prime then START at the SAME offset, b14=0 ---');
      await primeF6(8, 996, 'PH8D'); await startB14(8, 996, 0, 'PH8D');
      await primeF6(3, 2213, 'PH8D'); await startB14(3, 2213, 0, 'PH8D');
      L('--- E: SpO2 b14=0 paging (recSize 63) ---');
      for (const o of [1, 2, 63, 126, 189]) await startB14(1, o, 0, 'PH8E');
      L('--- F: pressure b14=0 paging (recSize 161) ---');
      for (const o of [1, 161, 322, 483]) await startB14(2, o, 0, 'PH8F');
      L('--- G: HR b14=0 small offsets ---');
      for (const o of [1, 2, 3, 2213]) await startB14(3, o, 0, 'PH8G');
    }
    async function startRaw(type, off, b14, oper, tag) {
      setItems(type, -1); setRec(type, 0);
      let pkt = new Uint8Array(buildV3Start04(type, off));
      pkt[14] = b14; pkt[12] = oper;
      const crc = crc16Ccitt(pkt, 1, pkt.length - 3);
      pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
      await tryWrite(writeChar, '0x0AF6', pkt, 'writeValue');
      await waitFor(() => getItems(type) >= 0, 6000, tag + ' t' + type + '@' + off);
      L('DIAG ' + tag + ' t=' + type + ' b14=0x' + b14.toString(16) + ' oper=' + oper + ' @' + off +
        ': items=' + getItems(type) + ' recSize=' + getRec(type));
      await tryWrite(writeChar, '0x0AF6', buildV3Stop04(type), 'writeValue');
      await wait(700);
    }
    async function ph9() {
      L('=== PH9: operate/b14 matrix for sport @0 on 0x0AF6 ===');
      for (const oper of [0, 2, 3]) for (const b14 of [0, 1, 2, 3, 0xFF]) await startRaw(8, 0, b14, oper, 'PH9');
      L('=== PH9b: same matrix for HR @0 ===');
      for (const b14 of [0, 2, 3, 0xFF]) await startRaw(3, 0, b14, 0, 'PH9b');
    }
    if (mode === 'ph7') { await ph7(); L('=== DIAG done ==='); return; }
    if (mode === 'ph8') { await ph8(); L('=== DIAG done ==='); return; }
    if (mode === 'ph9') { await ph9(); L('=== DIAG done ==='); return; }

    await ph1Matrix('PH1');

    L('=== PH2: 0x05 prime on 0x0AF6 (writeValue) + 0x04 START on 0x0AF6 ===');
    await roundF6(8, 0, 'PH2');
    await roundF6(8, 526, 'PH2');
    await roundF6(8, 1052, 'PH2');
    await roundF6(8, 17690, 'PH2');
    await roundF6(3, 507, 'PH2');

    L('=== PH3: 0x04 START on 0x0AF1 ===');
    setItems(8, -1);
    let b3 = lines.length;
    await tryWrite(healthWriteChar, '0x0AF1', buildV3Start04(8, 526), 'woR');
    await wait(4000);
    L('DIAG PH3 0x04-on-0x0AF1@526 woR: RXdelta=' + (lines.length - b3) + ' items=' + getItems(8));
    await tryWrite(healthWriteChar, '0x0AF1', buildV3Start04(8, 0), 'writeValue');
    await wait(1500);

    L('=== PH4: sport START sweep on 0x0AF6, NO 0x05 prime ===');
    for (const o of [0, 526, 1052, 2104, 5260, 10520, 17690, 18215, 18216]) {
      setItems(8, -1); setRec(8, 0);
      await tryWrite(writeChar, '0x0AF6', buildV3Start04(8, o), 'writeValue');
      await waitFor(() => getItems(8) >= 0, 12000, 'sweep@' + o);
      L('DIAG SWEEP @' + o + ': items=' + getItems(8) + ' recSize=' + getRec(8));
      await tryWrite(writeChar, '0x0AF6', buildV3Stop04(8), 'writeValue');
      await wait(1200);
    }

    L('=== PH6: count-data sweep on 0x0AF6 (sleep/workout/swim at many offsets) ===');
    // Day-data offsets were proven honored for SpO2/pressure but ignored for
    // sport/HR; count-data was only ever probed at offset 0 (+0..7,108 on the
    // phone) — never at larger byte offsets. Sweep them here.
    async function startOnly(type, off, byte14override) {
      setItems(type, -1); setRec(type, 0);
      let pkt = buildV3Start04(type, off);
      if (byte14override !== undefined && byte14override !== null) {
        pkt = new Uint8Array(pkt);
        pkt[14] = byte14override;
        const crc = crc16Ccitt(pkt, 1, pkt.length - 3);
        pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
      }
      await tryWrite(writeChar, '0x0AF6', pkt, 'writeValue');
      await waitFor(() => getItems(type) >= 0, 6000, 'ph6 t' + type + '@' + off);
      L('DIAG PH6 t=' + type + ' @' + off + (byte14override !== undefined && byte14override !== null ? ' b14=' + byte14override : '') +
        ': items=' + getItems(type) + ' recSize=' + getRec(type));
      await tryWrite(writeChar, '0x0AF6', buildV3Stop04(type), 'writeValue');
      await wait(900);
    }
    const coarse = [0, 40, 80, 120, 200, 400, 800, 1600, 3200, 6400, 9600, 12800, 16000, 17800, 18100, 18226];
    for (const t of [7, 4, 6]) { for (const o of coarse) await startOnly(t, o, null); }
    L('=== PH6b: sport/HR with byte14=0x00 (count-data flag) at record-step offsets ===');
    for (const o of [536, 1072, 2144, 5360, 10720, 17690]) await startOnly(8, o, 0x00);
    for (const o of [507, 1014, 2028, 5070, 17690]) await startOnly(3, o, 0x00);

    if (doBind) {
      L('=== BIND from Windows: 04 01 -> 03 23 -> 04 05 -> 02 01 ===');
      await wr(writeChar, '0x0AF6', buildBindStart());
      await wait(12000);
      await wr(writeChar, '0x0AF6', buildSet23Sample());
      await wait(2000);
      const auth = buildBindAuthPacket();
      if (auth) await wr(writeChar, '0x0AF6', auth);
      else L('DIAG BIND: no auth packet (no challenge captured)');
      await wait(3000);
      await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
      await wait(2500);
      await ph1Matrix('PH5-after-bind');
      await roundF6(8, 526, 'PH5-after-bind');
      await roundF6(8, 17690, 'PH5-after-bind');
    }

    L('=== DIAG done ===');
  } catch (e) {
    L('DIAG ERROR: ' + e + (e && e.stack ? ' | ' + e.stack : ''));
  }
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", action="store_true",
                    help="run bind/auth (04 01/03 23/04 05) from Windows, then re-test 0x0AF1 writes")
    ap.add_argument("--ph7", action="store_true",
                    help="run only PH7: page day-data history with byte14=0x00, offsets stepped by recSize")
    ap.add_argument("--ph8", action="store_true",
                    help="run only PH8: find how to page the b14=0 history stream (prime / small offsets / cursor)")
    ap.add_argument("--ph9", action="store_true",
                    help="run only PH9: operate/byte14 value matrix for sport/HR @0")
    ap.add_argument("--url", default="http://localhost:8080/pull.html")
    args = ap.parse_args()
    mode = 'ph9' if args.ph9 else ('ph8' if args.ph8 else ('ph7' if args.ph7 else 'full'))

    # Persistent profile: after the first native-picker click, getDevices()
    # returns the watch on every later launch (no picker needed again).
    profile = os.path.join(os.path.expanduser("~"), "AppData", "Local", "Temp", "id208-bt-profile")
    log(f"Opening {args.url} in headed Windows Chrome (persistent profile {profile})...")
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            profile,
            headless=False,
            args=["--enable-features=WebBluetooth",
                  "--enable-experimental-web-platform-features"],
            viewport={"width": 1280, "height": 900},
        )
        page = context.new_page()
        page.on("pageerror", lambda err: log(f"PAGEERROR: {err}"))

        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_timeout(1000)

        has_bt = page.evaluate("() => !!navigator.bluetooth")
        log(f"navigator.bluetooth available: {has_bt}")
        if not has_bt:
            log("ERROR: WebBluetooth not available (Windows BT off / no permission / not secure context).")
            context.close()
            sys.exit(1)

        # If the watch is OS-paired, skip the native picker via getDevices().
        paired = page.evaluate(
            """async () => {
                if (!navigator.bluetooth.getDevices) return 'getDevices unsupported';
                const devs = await navigator.bluetooth.getDevices();
                const d = devs.find(d => d.name && /ID208|IDO/i.test(d.name));
                if (!d) return 'no ID208 among paired: ' + devs.map(x => x.name || '?').join(', ');
                window.__pairedDevice = d;
                navigator.bluetooth.requestDevice = () => Promise.resolve(window.__pairedDevice);
                return 'patched requestDevice with paired device: ' + d.name;
            }"""
        )
        log(f"Paired-device check: {paired}")
        if "patched requestDevice" not in str(paired):
            # Wrap the real requestDevice so the native picker still works; we
            # just call connectAndSync ourselves with noAuto to skip the auto-sync.
            page.evaluate(
                """() => {
                    const orig = navigator.bluetooth.requestDevice.bind(navigator.bluetooth);
                    navigator.bluetooth.requestDevice = (opts) => orig(opts);
                }"""
            )
            print()
            print("=" * 64)
            print("  ACTION REQUIRED (if the native picker appears):")
            print("  >>> CLICK THE ID208 WATCH IN THE PICKER NOW <<<")
            print("=" * 64)
            print()
        else:
            log("Using the OS-paired watch directly (no native picker needed).")
            log("If GATT connect fails, wake the watch (tap its screen).")

        # Connect WITHOUT auto-sync — diagnostics only.
        log("Connecting with noAuto (no auto-sync)...")
        res = page.evaluate(
            "() => connectAndSync({noAuto: true}).then(() => 'connect ok', e => 'connect err: ' + e)"
        )
        log(f"connectAndSync: {res}")
        ready = wait_for_log(page, "Ready.", READY_TIMEOUT, "ready")
        wait_for_log(page, "Device Selected", PAIR_TIMEOUT, "pairing")
        save_page_state(page, "diag-connect")
        if not ready:
            log("ERROR: link not ready (no 'Ready.' in log) — aborting before diagnostics.")
            log("If a native picker is showing on the Windows desktop, click the ID208 and rerun.")
            context.close()
            sys.exit(1)

        log(f"Running diagnostic phases (mode={mode}, bind={args.bind and not args.ph7}) — this takes a few minutes...")
        t0 = time.time()
        try:
            page.evaluate(f"({DIAG_JS})({str(args.bind and mode == 'full').lower()}, {mode!r})")
        except Exception as e:
            log(f"DIAG evaluate raised: {e}")
        log(f"Diag evaluate returned after {int(time.time() - t0)}s")
        save_page_state(page, "diag")

        full_log = page.evaluate("() => document.getElementById('log')?.textContent || ''")
        for line in full_log.splitlines():
            if any(k in line for k in ("DIAG", "PHASE", "BIND", "INFO 02 01", "SPORT dataType", "HR dataType")):
                print("  " + line[:250], flush=True)

        log("Diag outputs: diag-connect-*, diag-log.txt, diag.jsonl, diag-store.json")
        context.close()


if __name__ == "__main__":
    main()
