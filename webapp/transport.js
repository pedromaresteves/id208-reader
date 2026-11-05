/* ID208 transport — GATT connect, notify, writes, v3 reassembly.
 *
 * State stays in top-level vars (classic scripts) so existing page wiring can
 * keep passing writeChar/healthWriteChar while the modules are the source.
 */
var IDO = window.IDO || (window.IDO = {});

var writeChar, notifyChar, healthWriteChar, healthNotifyChar;
var device = null;
var rxBuf = null, rxWritten = 0;
var lines = []; // {ts, char, dir, hex}
var lastPair = -1;

IDO.transport = (function () {
  'use strict';

  function v3TotalLen(first) { return first[6] | (first[7] << 8); }

  function record(char, dir, arr) {
    lines.push({
      ts: new Date().toISOString(),
      char: char,
      dir: dir,
      hex: IDO.shell.hexStr(arr).replace(/ /g, ''),
    });
    IDO.shell.log((dir === 'TX' ? 'TX : ' : 'RX : ') + IDO.shell.hexStr(arr) + '  [' + char + ']');
  }

  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // Reply-driven wait: resolves when isDone() is true (polled every 250 ms),
  // or after capMs. A timeout never cuts a frame: reassembly always finishes.
  function waitFor(isDone, capMs, label) {
    var waited = 0;
    return new Promise(function (resolve) {
      function poll() {
        var done = false;
        try { done = !!isDone(); } catch (e) { done = false; }
        if (done || waited >= capMs) {
          if (!done) IDO.shell.log('Timeout waiting (' + label + ') — continuing anyway.');
          resolve();
          return;
        }
        waited += 250;
        setTimeout(poll, 250);
      }
      poll();
    });
  }

  function handleLegacy(arr) {
    if (arr.length >= 3 && arr[0] === 0x04 && (arr[1] === 0x01 || arr[1] === 0x02 || arr[1] === 0x03 || arr[1] === 0x05)) {
      if (arr[1] === 0x01 && arr.length >= 17) {
        var mac = arr.slice(5, 11);
        var challenge = arr.slice(11, 17); // watch clock, sealed with MAC into 04 05
        IDO.codec.setBindData(mac, challenge);
        IDO.shell.show('BIND reply: key=0x01 status=' + arr[2] + ' challenge=' +
          IDO.shell.hexStr(challenge) + ' (captured for 04 05 auth)');
      } else {
        IDO.shell.show('BIND reply: key=0x0' + arr[1].toString(16) + ' status=' + arr[2] +
          ' (00 = ok; 04 05 status 0 finalizes, QR should clear)');
      }
      return;
    }
    if (arr.length >= 2 && arr[0] === 0x02 && arr[1] === 0x01) {
      var pair = arr.length > 8 ? arr[8] : -1;
      var bindFlag = arr.length > 13 ? arr[13] : -1;
      lastPair = pair; // drives the auto-sync decision after Connect
      IDO.shell.show('INFO 02 01: pair=' + pair + ' bind_flag=' + bindFlag +
        ' (bound usually pair=1; fresh reset shows QR until bind)');
      return;
    }
    if (arr.length >= 2 && arr[0] === 0x03) {
      IDO.shell.show('SET ack: 03 ' + arr[1].toString(16) + ' (00s = ok)');
    }
  }

  function dispatchV3(buf) {
    // buf starts with DA AD DA AD; cmd [7..8], seq [9..10], payload [11..].
    if (buf.length < 11) return;
    var cmd = buf[7] | (buf[8] << 8), seq = buf[9] | (buf[10] << 8);
    var p = buf.subarray(11);
    IDO.shell.log('v3 complete: cmd=0x' + cmd.toString(16) + ' seq=0x' +
      seq.toString(16) + ' payloadBytes=' + p.length);
    if (cmd === 0x0005 && p.length >= 4) {
      var total = IDO.codec.u32le(p, 0);
      IDO.shell.show('Health sizes reply: totalBytes=' + total + ' (expect ~1021 if watch has fresh data)');
      IDO.shell.log('0x05 reply payload ' + p.length + 'B: ' + IDO.shell.hexStr(p));
      for (var ri = 4; ri + 5 <= p.length; ri += 5) {
        IDO.shell.log('  0x05 rec type=0x' + p[ri].toString(16) + ' val=' + IDO.codec.u32le(p, ri + 1));
      }
      return;
    }
    if (cmd !== 0x0004) return;
    var decoded = IDO.codec.decodeHealth(p);
    if (decoded) IDO.sync.capture(decoded);
  }

  function handleV3(arr) {
    var inAsm = rxBuf && rxWritten < rxBuf.length && rxWritten > 0;
    if (inAsm && arr[0] === 0x33 && !(arr.length >= 5 && arr[1] === 0xDA && arr[2] === 0xAD)) {
      var n = Math.min(arr.length - 1, rxBuf.length - rxWritten);
      rxBuf.set(arr.subarray(1, 1 + n), rxWritten); rxWritten += n;
    } else if (arr[0] === 0x33 && arr[1] === 0xDA && arr[2] === 0xAD && arr[3] === 0xDA && arr[4] === 0xAD && arr.length >= 10) {
      var total = v3TotalLen(arr);
      if (total <= 0 || total > 8192) return;
      rxBuf = new Uint8Array(total); rxWritten = 0;
      var m = Math.min(total, arr.length - 1);
      rxBuf.set(arr.subarray(1, 1 + m), 0); rxWritten = m;
    } else return;
    if (rxBuf && rxWritten === rxBuf.length) { dispatchV3(rxBuf); rxBuf = null; rxWritten = 0; }
  }

  function onNotifyF7(e) {
    var a = new Uint8Array(e.target.value.buffer);
    record('0x0AF7', 'RX', a);
    handleV3(a);
    handleLegacy(a);
    if (a.length >= 18 && a[0] === 0x02 && a[1] === 0xA0) {
      IDO.sync.setLive({
        steps: IDO.codec.u32le(a, 2),
        distanceM: IDO.codec.u32le(a, 10),
        ts: new Date().toISOString(),
      });
    }
    if (a.length >= 2 && a[0] === 0x07 && a[1] === 0x40) {
      IDO.shell.log('ACK 07 40 (mirroring back on 0x0AF6)');
      wr(writeChar, '0x0AF6', a);
    }
  }

  function onNotifyF2(e) {
    var a = new Uint8Array(e.target.value.buffer);
    record('0x0AF2', 'RX', a);
    handleV3(a);
    handleLegacy(a);
  }

  function wr(ch, name, bytes) {
    if (!ch) {
      IDO.shell.log('Not attached: ' + name + ' (connect first / health chars missing)');
      return Promise.reject(new Error('no char ' + name));
    }
    record(name, 'TX', bytes);
    return ch.writeValue(bytes).catch(function (e) {
      IDO.shell.log('Write failed ' + name + ': ' + e);
    });
  }

  function connectAndSync(opts) {
    opts = opts || {};
    if (device && device.gatt.connected && writeChar && notifyChar) {
      IDO.shell.log('Already connected — reusing link.');
      if (opts.noAuto) return Promise.resolve();
      return IDO.sync.autoSyncAfterConnect(opts);
    }
    IDO.shell.log('Requesting device (tap the ID208 in the picker, then Pair)...');
    return navigator.bluetooth.requestDevice({ filters: [{ services: [0x0AF0] }] })
      .then(function (dev) {
        device = dev;
        IDO.shell.log('Device Selected: ' + (dev.name || '?'));
        device.addEventListener('gattserverdisconnected', function () {
          IDO.shell.log('GATT disconnected (watch dropped link or another app stole it)');
        });
        return setupLinkWithRetry(dev, 3).then(function () {
          if (opts.noAuto) { IDO.shell.log('Link ready (auto-sync skipped).'); return; }
          return IDO.sync.autoSyncAfterConnect(opts);
        });
      })
      .catch(function (err) {
        IDO.shell.log('BT error: ' + err);
        IDO.shell.log('Fix checklist: 1) force-stop VeryFit 2) Android Settings > Bluetooth > forget ID208 if bonded 3) toggle BT off/on 4) reboot watch (hold button) 5) Chrome location permission on 6) stay within 1m 7) retry. Tell me the LAST ok-line above (e.g. 0x0AF6 ok) plus this error.');
        throw err;
      });
  }

  // GATT connect + service/char/notify setup, retried. The watch is a single
  // master: another host can drop the link right after connect(); retry wins.
  function setupLinkWithRetry(dev, attempts) {
    var n = 0;
    function once() {
      n++;
      if (dev.gatt.connected) IDO.shell.log('Already connected at GATT level, reusing');
      else IDO.shell.log('GATT connecting (attempt ' + n + '/' + attempts + ')...');
      return Promise.resolve()
        .then(function () { return dev.gatt.connected ? dev.gatt : dev.gatt.connect(); })
        .then(function (server) {
          return new Promise(function (res, rej) {
            setTimeout(function () { dev.gatt.connected ? res(server) : rej(new Error('GATT dropped right after connect')); }, 800);
          });
        })
        .then(function (server) { IDO.shell.log('GATT Connected; getting service 0x0AF0...'); return server.getPrimaryService(0x0AF0); })
        .then(function (svc) {
          IDO.shell.log('Service found; getting 0x0AF6 (write)...');
          return svc.getCharacteristic(0x0AF6).then(function (c) {
            writeChar = c; IDO.shell.log('0x0AF6 ok');
            IDO.shell.log('Getting 0x0AF7 (notify)...');
            return svc.getCharacteristic(0x0AF7);
          }).then(function (c) {
            notifyChar = c; IDO.shell.log('0x0AF7 ok');
            IDO.shell.log('Getting 0x0AF1 (health write)...');
            return svc.getCharacteristic(0x0AF1).then(function (h) {
              healthWriteChar = h; IDO.shell.log('0x0AF1 ok'); return svc;
            }, function (e) {
              IDO.shell.log('0x0AF1 MISSING: ' + e + ' (staying on legacy 0x0AF6/0x0AF7 only)'); return svc;
            });
          }).then(function (s) {
            IDO.shell.log('Getting 0x0AF2 (health notify)...');
            return s.getCharacteristic(0x0AF2).then(function (h) {
              healthNotifyChar = h; IDO.shell.log('0x0AF2 ok');
            }, function (e) {
              IDO.shell.log('0x0AF2 MISSING: ' + e + ' (staying on legacy only)');
            });
          }).then(function () {
            try { IDO.shell.log('props 0x0AF6: ' + JSON.stringify(writeChar.properties)); } catch (e) {}
            try { IDO.shell.log('props 0x0AF1: ' + JSON.stringify(healthWriteChar && healthWriteChar.properties)); } catch (e) {}
          });
        })
        .then(function () {
          // Named handlers + remove-before-add: reconnecting must not stack
          // duplicate listeners (every RX would log twice).
          notifyChar.removeEventListener('characteristicvaluechanged', onNotifyF7);
          notifyChar.addEventListener('characteristicvaluechanged', onNotifyF7);
          if (healthNotifyChar) {
            healthNotifyChar.removeEventListener('characteristicvaluechanged', onNotifyF2);
            healthNotifyChar.addEventListener('characteristicvaluechanged', onNotifyF2);
          }
          IDO.shell.log('Starting notify 0x0AF7...');
          return notifyChar.startNotifications().then(function () { IDO.shell.log('Notify ON 0x0AF7'); });
        })
        .then(function () {
          IDO.shell.enableIds(PAGE_BASIC_BUTTONS);
          if (!healthNotifyChar) {
            IDO.shell.log('Health notify unavailable; legacy 0x0AF6/0x0AF7 ready (buttons 2-3 + setup macro)');
            return;
          }
          IDO.shell.log('Waiting 500ms before 0x0AF2 (watch dislikes back-to-back CCCD writes)...');
          return new Promise(function (res) { setTimeout(res, 500); }).then(function () {
            IDO.shell.log('Starting notify 0x0AF2...');
            return healthNotifyChar.startNotifications().then(function () { IDO.shell.log('Notify ON 0x0AF2'); });
          }).then(function () {
            IDO.shell.enableIds(PAGE_FULL_BUTTONS);
            IDO.shell.log('Ready.');
          }, function (e) {
            IDO.shell.log('Notify FAILED 0x0AF2: ' + e);
            IDO.shell.log('Continuing with legacy only (buttons 2-3 work). For health: Android Settings > Bluetooth > Forget ID208, reboot watch, retry Connect — 0x0AF2 notify is refused on stale bonds.');
          });
        })
        .catch(function (e) {
          IDO.shell.log('Link setup attempt ' + n + '/' + attempts + ' failed: ' + e);
          if (n >= attempts) throw e;
          return wait(2000).then(once);
        });
    }
    return once();
  }

  function ensureLink() {
    if (device && device.gatt.connected && writeChar) {
      IDO.shell.log('Link already up.');
      return Promise.resolve();
    }
    return connectAndSync({ noAuto: true });
  }

  return {
    record: record,
    wait: wait,
    waitFor: waitFor,
    handleLegacy: handleLegacy,
    handleV3: handleV3,
    dispatchV3: dispatchV3,
    onNotifyF7: onNotifyF7,
    onNotifyF2: onNotifyF2,
    wr: wr,
    connectAndSync: connectAndSync,
    setupLinkWithRetry: setupLinkWithRetry,
    ensureLink: ensureLink,
  };
})();

// Compatibility aliases for page wiring/tests.
var record = IDO.transport.record;
var wait = IDO.transport.wait;
var waitFor = IDO.transport.waitFor;
var handleLegacy = IDO.transport.handleLegacy;
var handleV3 = IDO.transport.handleV3;
var dispatchV3 = IDO.transport.dispatchV3;
var onNotifyF7 = IDO.transport.onNotifyF7;
var onNotifyF2 = IDO.transport.onNotifyF2;
var wr = IDO.transport.wr;
var connectAndSync = IDO.transport.connectAndSync;
var setupLinkWithRetry = IDO.transport.setupLinkWithRetry;
var ensureLink = IDO.transport.ensureLink;
