// JS side of the JS<->Python parity test: decode the golden capture with the
// same ble.js code the phone runs, then either print canonical records
// (--json, consumed by tests/test_parity.py) or assert the golden summary.
// Plain node, no deps:   node webapp/parity.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = process.argv[2] && process.argv[2].charAt(0) !== '-'
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'tests', 'fixtures', 'history-5day.jsonl');
const EXPECTED = path.join(ROOT, 'tests', 'fixtures', 'history-5day.expected.json');
const AS_JSON = process.argv.includes('--json');

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
    '\nglobalThis.B = { handleV3, saveCaptured, resetCaptures };',
);
const B = globalThis.B;

function canonical() {
  const byType = {};
  puts.forEach((p) => {
    (byType[p.type] = byType[p.type] || []).push(p.payload);
  });
  const sorted = (rows) => (rows || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  return {
    steps: sorted(byType.steps).map((r) => ({
      date: r.date,
      steps: r.steps,
      distance_m: r.distance_m,
      kcal: r.kcal,
      active_min: r.active_min,
    })),
    hr: sorted(byType.hr).map((r) => ({
      date: r.date,
      startS: r.start_time_s,
      silent: r.silent_hr,
      zones: (r.zones || []).map((z) => (z && typeof z === 'object' ? z.thr : z)),
      samples: (r.samples || []).map((s) => ({ t: s.t, bpm: s.bpm })),
    })),
    spo2: sorted(byType.spo2).map((r) => ({
      date: r.date,
      startS: r.startS,
      items: r.items,
      samples: (r.samples || []).map((s) => ({ t: s.t, value: s.value })),
    })),
    pressure: sorted(byType.pressure).map((r) => ({
      date: r.date,
      startS: r.startS,
      items: r.items,
      samples: (r.samples || []).map((s) => ({ t: s.t, value: s.value })),
    })),
  };
}

function summary(c) {
  const first = (rows) => (rows.length ? rows[0] : null);
  const last = (rows) => (rows.length ? rows[rows.length - 1] : null);
  return {
    steps: c.steps,
    hr: c.hr.map((r) => ({
      date: r.date,
      startS: r.startS,
      silent: r.silent,
      zones: r.zones,
      sample_count: r.samples.length,
      first: first(r.samples),
      last: last(r.samples),
    })),
    spo2: c.spo2.map((r) => ({
      date: r.date,
      items: r.items,
      sample_count: r.samples.length,
    })),
    pressure: c.pressure.map((r) => ({
      date: r.date,
      items: r.items,
      sample_count: r.samples.length,
    })),
  };
}

(async () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n')
    .filter((ln) => ln.trim() !== '')
    .map((ln) => JSON.parse(ln));

  // ble.js logs every frame; keep stdout clean for --json.
  const realLog = console.log;
  console.log = () => {};
  try {
    B.resetCaptures();
    lines.forEach((ln) => {
      if (ln.dir !== 'RX' || !ln.hex) return;
      const bytes = new Uint8Array(Buffer.from(ln.hex, 'hex'));
      if (bytes.length && bytes[0] === 0x33) B.handleV3(bytes);
    });
    await B.saveCaptured('parity');
  } finally {
    console.log = realLog;
  }

  const c = canonical();
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(c) + '\n');
    return;
  }

  // Phantoms (zeroed items=0 markers) must never become records.
  const dates = [].concat(c.steps, c.hr, c.spo2, c.pressure).map((r) => r.date);
  assert.ok(!dates.includes('0-00-00'), 'no 0-00-00 phantom date');
  assert.ok(!dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d)), 'every date is YYYY-MM-DD');
  assert.strictEqual(c.steps.length, 5, 'five completed sport days, got ' + c.steps.length);
  assert.strictEqual(c.hr.length, 5, 'five completed HR days, got ' + c.hr.length);
  assert.strictEqual(c.spo2.length, 5, 'five SpO2 days, got ' + c.spo2.length);
  assert.strictEqual(c.pressure.length, 5, 'five pressure days, got ' + c.pressure.length);
  assert.deepStrictEqual(
    summary(c),
    JSON.parse(fs.readFileSync(EXPECTED, 'utf8')),
    'JS decode matches the golden summary',
  );
  console.log('parity.test.js: JS decode matches tests/fixtures/history-5day.expected.json');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
