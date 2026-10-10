// Capture-to-store regression test: real watch bytes in, stored record out.
// Guards the snake/camel key mismatch that once dropped distance_m silently.
// Plain node, no deps:   node webapp/capture.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

function makeEl() {
  return {
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
    appendChild() {},
  };
}
global.window = {};
const __els = {};
global.document = {
  getElementById: (id) => (__els[id] || (__els[id] = makeEl())),
  createElement: () => makeEl(),
  createTextNode: (t) => ({ text: t }),
  body: makeEl(),
};
// NOTE: no navigator stub — node 22 ships a read-only global one, and ble.js
// only touches navigator inside connectAndSync (never exercised here).

const puts = [];
global.Store = {
  put: (date, type, payload) => {
    puts.push({ date, type, payload });
    return Promise.resolve();
  },
  list: () => Promise.resolve([]),
};

eval(
  fs.readFileSync(path.join(ROOT, 'webapp', 'ble.js'), 'utf8') +
    '\nglobalThis.B = { handleV3, saveCaptured, resetCaptures };'
);
const B = globalThis.B;

// Real v3 sport reply, 2026-10-03: 10065 steps / 7641 m / 631 kcal (watch-verified).
const CHUNKS = [
  '33DAADDAAD01F90204006100000801000046002400BC0200000000EA070A0300000F5127000086070000D91D00001E0000004600770200000A0000000000001600000B00070030000000000003000000160000000000020000001500000700000500000018000000000008000000190000000000020000001500006100000B0058001E00001700000D000B00200000160000080016001B0000B400000E0091002100005E00001A0048002D0000B900000F008C00',
  '332000000000000100000014000000000000000000130000000000000000001300000000000000000013000000000000000000130000000000000000001300000000000000000011000000000000000000130000000000000000001300000000000000000013000000000000000000130000000000010000001400000000000000000011000000000001000000140000000000000000001300000000000000000013000000000001000000140000000000000000',
  '330013000000000001000000140000000000000000001100000000000100000014000000000000000000130000000000010000001400000000000000000013000000000000000000130000000000020000001300000A01000C00CB001F0000560303170083022A0000AC03072100BC023400009B04081D007103300000B3010115003F012800003D040624002F03370000EF03051D00F402300000A000000B0071001C00006A00000A0055001D00007501001000',
  '3315012300005801001200FF00250000F900000D00C200200000A9010012007301250000890100270037013A0000E100001500A800260000DC00001200A8002500000B00000A0006001D00002F01000C00F0001F00000C0000080006001B0000000000060000001900003D0000070021001A00002000000600150017000014000007001E001A00000C0000040004001700001801000F00DD0022000000000021000000340000BD0000120089002500005E00000B',
  '33004F001E000063000009004A001A000000000002000000050000210000070019001700001C0000020015000700',
];

(async () => {
  B.resetCaptures();
  CHUNKS.forEach((hex) => B.handleV3(new Uint8Array(Buffer.from(hex, 'hex'))));
  await B.saveCaptured('test');
  const rows = puts.filter((p) => p.type === 'steps');
  assert.strictEqual(rows.length, 1, 'one steps record, got ' + rows.length);
  const r = rows[0].payload;
  assert.strictEqual(r.steps, 10065, 'steps decoded');
  assert.ok('distance_m' in r, 'distance_m key present (was dropped by key mismatch)');
  assert.strictEqual(r.distance_m, 7641, 'distance decoded');
  assert.strictEqual(r.kcal, 631, 'display kcal decoded');
  console.log('capture.test.js: all assertions passed');

  // Workout log line renders distance with 2 decimals (was "1.469km").
  // Synthetic type-04 frame: 1469 m at header [25:29], pace 749 s at [40:42].
  const wHead = Buffer.alloc(100, 0);
  wHead.writeUInt32LE(1101, 17);
  wHead.writeUInt32LE(85, 21);
  wHead.writeUInt32LE(1469, 25);
  wHead[29] = 93; wHead[30] = 121; wHead[31] = 74;
  wHead.writeUInt16LE(749, 40);
  const wPay = Buffer.concat([
    Buffer.from([0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 100, 0x00, 8, 0x00, 0x00, 0x00, 0x00]),
    wHead,
    Buffer.from([70, 80, 90, 100, 0, 0, 0, 0]),
  ]);
  const wBuf = Buffer.concat([Buffer.from([0xDA, 0xAD, 0xDA, 0xAD, 0x01, 0, 0, 0x04, 0x00, 0x61, 0x00]), wPay]);
  wBuf.writeUInt16LE(wBuf.length, 5);
  B.resetCaptures();
  B.handleV3(new Uint8Array(Buffer.concat([Buffer.from([0x33]), wBuf])));
  const decoded = global.document.getElementById('decoded').innerHTML;
  assert.ok(decoded.includes('1.47km'), 'workout log shows 2-decimal km, got: ' + decoded);
  assert.ok(!decoded.includes('1.469km'), 'no 3-decimal km left in: ' + decoded);
  console.log('capture.test.js: workout log format passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
