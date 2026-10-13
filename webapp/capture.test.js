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
    '\nglobalThis.B = { handleV3, saveCaptured, resetCaptures, dayDiff, upsertDay };'
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
  assert.strictEqual(r.date, '2026-10-03', 'sport header date stamped, got ' + r.date);
  assert.strictEqual(rows[0].date, '2026-10-03', 'store key uses header date, got ' + rows[0].date);
  const stamp = puts.filter((p) => p.type === 'meta');
  assert.ok(stamp.length >= 1, 'last-sync stamp written, got ' + stamp.length);
  assert.strictEqual(stamp[stamp.length - 1].date, 'last-sync', 'stamp key');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(stamp[stamp.length - 1].payload.day), 'stamp day is YYYY-MM-DD');
  console.log('capture.test.js: all assertions passed');

  // Multi-day sport: two day-offset replies land under distinct header
  // dates (never collapsed onto the phone's today).
  function sportFrame(day, steps, dist, kcal, seq) {
    const head = Buffer.alloc(28, 0);
    head.writeUInt16LE(2026, 1); head[3] = 10; head[4] = day;
    head.writeUInt32LE(steps, 8);
    head.writeUInt32LE(999, 12);
    head.writeUInt32LE(dist, 16);
    head.writeUInt32LE(30, 20);
    head.writeUInt16LE(kcal, 26);
    const pay = Buffer.concat([
      Buffer.from([0x00, 0x08, 0x00, 0x00, 0x00, 0x05, 0x00, 28, 0x00, 0, 0x00, 0x00, 0x00, 0x00]),
      head,
    ]);
    const buf = Buffer.concat([Buffer.from([0xDA, 0xAD, 0xDA, 0xAD, 0x01, 0, 0, 0x04, 0x00, seq, 0x00]), pay]);
    buf.writeUInt16LE(buf.length, 5);
    return new Uint8Array(Buffer.concat([Buffer.from([0x33]), buf]));
  }
  B.resetCaptures();
  B.handleV3(sportFrame(12, 8000, 6100, 450, 0x71));
  B.handleV3(sportFrame(11, 5000, 3800, 300, 0x72));
  const mdBefore = puts.length;
  await B.saveCaptured('multiday');
  const mdRows = puts.slice(mdBefore).filter((p) => p.type === 'steps');
  assert.strictEqual(mdRows.length, 2, 'two step days saved, got ' + mdRows.length);
  assert.deepStrictEqual(mdRows.map((p) => p.date).sort(), ['2026-10-11', '2026-10-12']);
  assert.strictEqual(mdRows.filter((p) => p.payload.steps === 8000)[0].payload.kcal, 450);
  console.log('capture.test.js: multiday sport passed');

  // Incremental-sync helpers: day gaps and per-date upsert.
  assert.strictEqual(B.dayDiff('2026-10-10', '2026-10-13'), 3);
  assert.strictEqual(B.dayDiff('2026-10-13', '2026-10-13'), 0);
  const ul = [{ date: '2026-10-12', steps: 1 }];
  B.upsertDay(ul, { date: '2026-10-11', steps: 2 });
  B.upsertDay(ul, { date: '2026-10-12', steps: 9 });
  assert.strictEqual(ul.length, 2, 'upsert adds, second call replaces');
  assert.strictEqual(ul.filter((e) => e.date === '2026-10-12')[0].steps, 9);
  console.log('capture.test.js: sync helpers passed');

  // Workout log line renders distance with 2 decimals (was "1.469km").
  // Synthetic type-04 frame: 1469 m at header [25:29], pace 749 s at [40:42].
  const wHead = Buffer.alloc(100, 0);
  wHead.writeUInt32LE(1101, 17);
  wHead.writeUInt32LE(85, 21);
  wHead.writeUInt32LE(1469, 25);
  wHead[29] = 93; wHead[30] = 121; wHead[31] = 74;
  wHead.writeUInt16LE(749, 40);
  wHead.writeUInt16LE(2026, 1); wHead[3] = 10; wHead[4] = 8; // header date, not phone date
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

  // Header-date stamp: re-pulls overwrite the same keys instead of
  // duplicating historic workouts under each sync day.
  const putsBeforeDate = puts.length;
  await B.saveCaptured('datestamp');
  const dated = puts.slice(putsBeforeDate).filter((p) => p.type === 'workout');
  assert.strictEqual(dated.length, 1, 'one workout saved, got ' + dated.length);
  assert.strictEqual(dated[0].payload.date, '2026-10-08', 'header date stamped, got ' + dated[0].payload.date);
  assert.strictEqual(dated[0].date, '2026-10-08 0', 'store key uses header date, got ' + dated[0].date);
  console.log('capture.test.js: date stamp passed');

  // Phantom guard: a real empty-history type-04 reply (2026-10-11 pull:
  // items=0, 100 zero bytes) must capture NOTHING — it used to save one
  // all-zeros workout per sync day under "<date> 0".
  const EMPTY04 =
    '33DAADDAAD017D0004006100000400000000006400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
  B.resetCaptures();
  B.handleV3(new Uint8Array(Buffer.from(EMPTY04, 'hex')));
  const putsBefore = puts.length;
  await B.saveCaptured('phantom');
  const phantomRows = puts.slice(putsBefore).filter((p) => p.type === 'workout');
  assert.strictEqual(phantomRows.length, 0, 'empty-history reply saves no workout, got ' + phantomRows.length);
  console.log('capture.test.js: phantom guard passed');

  // Same phantom family for sleep: a zeroed dataType-07 frame (items=0)
  // used to store a "0-00-00" zero-night on every empty pull.
  const sPay = Buffer.concat([
    Buffer.from([0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 16, 0x00, 0, 0x00, 0x00, 0x00, 0x00]),
    Buffer.alloc(16, 0),
  ]);
  const sBuf = Buffer.concat([Buffer.from([0xDA, 0xAD, 0xDA, 0xAD, 0x01, 0, 0, 0x04, 0x00, 0x61, 0x00]), sPay]);
  sBuf.writeUInt16LE(sBuf.length, 5);
  B.resetCaptures();
  B.handleV3(new Uint8Array(Buffer.concat([Buffer.from([0x33]), sBuf])));
  const putsBeforeSleep = puts.length;
  await B.saveCaptured('phantom-sleep');
  const sleepRows = puts.slice(putsBeforeSleep).filter((p) => p.type === 'sleep');
  assert.strictEqual(sleepRows.length, 0, 'empty sleep reply saves no night, got ' + sleepRows.length);
  console.log('capture.test.js: sleep phantom guard passed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
