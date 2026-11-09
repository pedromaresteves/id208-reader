// Logic harness: runs ui.js stackedBarChart against a stub canvas/DOM.
// No browser, no deps: node webapp/chart.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

// ---- Minimal DOM stub ----
const elements = {};
function makeCanvas() {
  return {
    clientWidth: 600,
    clientHeight: 140,
    width: 0,
    height: 0,
    _bars: [],
    calls: [],
    getContext() {
      const calls = this.calls;
      return new Proxy({}, {
        get(t, prop) {
          if (prop === 'canvas') return undefined;
          return (...args) => { calls.push([prop, ...args]); };
        },
        set(t, prop, v) { calls.push(['set:' + prop, v]); return true; },
      });
    },
  };
}
global.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
global.document = {
  getElementById(id) {
    if (!elements[id]) elements[id] = (id === 'chSleepWeek') ? makeCanvas() : { textContent: '' };
    return elements[id];
  },
};

eval(
  fs.readFileSync(path.join(ROOT, 'webapp', 'ui.js'), 'utf8') +
    '\nglobalThis.U = { stackedBarChart, barAt, setupCanvas, fmtHM, fmtMinutes, kmOrDash, hrStats, hrCell,' +
    ' monthKey, addMonths, daysInMonth, addDays, mondayOf, weeksOf, sleepScore, DEFAULT_GOALS,' +
    ' wireMonthNav, isoWeek, parseNightDateTime, nightInProgress };'
);
const U = globalThis.U;

function nights(n, total) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      label: '10-' + (10 + i),
      total: total,
      parts: [
        { v: 70, color: '#1d4ed8', name: 'deep' },
        { v: 130, color: '#a78bfa', name: 'REM' },
        { v: 200, color: '#93c5fd', name: 'light' },
        { v: 20, color: '#e5e7eb', name: 'awake' },
      ],
    });
  }
  return out;
}

// 7 nights, last selected: all 7 bars drawn, 6 dimmed, 1 full.
U.stackedBarChart('chSleepWeek', nights(7, 420), 6);
const canvas = elements['chSleepWeek'];
assert.strictEqual(canvas._bars.length, 7, 'all 7 bars registered, got ' + canvas._bars.length);
const rects = canvas.calls.filter((c) => c[0] === 'fillRect');
assert.strictEqual(rects.length, 7 * 4, 'all 7x4 segments drawn, got ' + rects.length);
const alphas = canvas.calls.filter((c) => c[0] === 'set:globalAlpha').map((c) => c[1]);
const dimmed = alphas.filter((a) => a === 0.5).length;
assert.strictEqual(dimmed, 6, 'exactly 6 dimmed bars, got ' + dimmed);

// Labels crisp inputs: backing store scaled by devicePixelRatio.
assert.strictEqual(canvas.width, 1200, 'backing width scaled x2');
assert.strictEqual(canvas.height, 280, 'backing height scaled x2');

// Tap geometry resolves per bar.
for (let i = 0; i < 7; i++) {
  const mid = (canvas._bars[i].x0 + canvas._bars[i].x1) / 2;
  assert.strictEqual(U.barAt('chSleepWeek', mid), i, 'tap hits bar ' + i);
}

// Per-bar totalText overrides the fmtHM label (empty days, partial nights).
canvas.calls.length = 0;
U.stackedBarChart('chSleepWeek', [{ label: '11-08', total: 0, parts: [], totalText: '' }], 0);
const barLabels = canvas.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
assert.ok(!barLabels.includes('0h00m'), 'empty totalText hides the zero label');
assert.ok(barLabels.includes('11-08'), 'date label still drawn');

// fmtHM sanity.
assert.strictEqual(U.fmtHM(425), '7h05m');
assert.strictEqual(U.fmtHM(0), '0h00m');

// fmtMinutes: types 01/02 store minutes since midnight (1410 = 23:30).
assert.strictEqual(U.fmtMinutes(1410), '23:30');
assert.strictEqual(U.fmtMinutes(6), '00:06');
assert.strictEqual(U.fmtMinutes(0), '00:00');
assert.strictEqual(U.fmtMinutes(1440), '00:00');
assert.strictEqual(U.fmtMinutes(undefined), '—');

// kmOrDash: 2 decimals everywhere, missing stays a dash (never 0-conflated).
assert.strictEqual(U.kmOrDash(7641), '7.64km');
assert.strictEqual(U.kmOrDash(1469), '1.47km');
assert.strictEqual(U.kmOrDash(0), '0.00km');
assert.strictEqual(U.kmOrDash(null), '—');
assert.strictEqual(U.kmOrDash(undefined), '—');

// Month/week date helpers (Monday-start weeks).
assert.strictEqual(U.monthKey('2026-10-03'), '2026-10');
assert.strictEqual(U.addMonths('2026-10', 1), '2026-11');
assert.strictEqual(U.addMonths('2026-01', -1), '2025-12');
assert.strictEqual(U.daysInMonth('2026-02'), 28);
assert.strictEqual(U.addDays('2026-10-31', 1), '2026-11-01');
assert.strictEqual(U.mondayOf('2026-10-11'), '2026-10-05', 'Sunday maps back to Monday');
assert.strictEqual(U.mondayOf('2026-10-05'), '2026-10-05', 'Monday maps to itself');
const octWeeks = U.weeksOf('2026-10');
assert.strictEqual(octWeeks.length, 5, 'Oct 2026 spans 5 Mon-Sun weeks, got ' + octWeeks.length);
assert.strictEqual(octWeeks[0].start, '2026-09-28', 'first week spills into Sep');
assert.strictEqual(octWeeks[4].end, '2026-11-01', 'last week spills into Nov');

// ISO week numbers (weeks already run Monday–Sunday).
assert.strictEqual(U.isoWeek('2026-10-05'), 41, 'Oct 5 2026 is Monday of W41');
assert.strictEqual(U.isoWeek('2026-10-11'), 41, 'same week Sunday is still W41');
assert.strictEqual(U.isoWeek('2026-01-01'), 1, 'Jan 1 2026 (Thursday) is W1');
assert.strictEqual(U.isoWeek('2025-12-29'), 1, 'Dec 29 2025 (Monday) is W1');

// Sleep rating from stage baselines.
const balanced = U.sleepScore({ light_min: 240, deep_min: 60, rem_min: 90 });
assert.strictEqual(balanced.label, 'Excellent', 'balanced night rates Excellent, got ' + balanced.label);
const restless = U.sleepScore({ light_min: 400, deep_min: 10, rem_min: 10 });
assert.strictEqual(restless.label, 'Poor', 'light-dominated night rates Poor, got ' + restless.label);
assert.strictEqual(U.sleepScore({ light_min: 0, deep_min: 0, rem_min: 0 }), null, 'no sleep scores null');

// hrStats/hrCell: daily HR join for the Activity page (type03 samples).
assert.deepStrictEqual(
  U.hrStats({ samples: [{ t: 1, bpm: 60 }, { t: 2, bpm: 80 }, { t: 3, bpm: 70 }], silent_hr: 61 }),
  { avg: 70, min: 60, max: 80, count: 3, silent: 61 });
assert.strictEqual(U.hrCell({ samples: [60, 80, 70] }), '70 (60–80)');
assert.strictEqual(U.hrCell({ samples: [] }), '—');
assert.strictEqual(U.hrCell(null), '—');
assert.strictEqual(U.hrCell({ samples: [0, 255, 70] }), '70 (70–70)', 'out-of-range BPMs ignored');
assert.strictEqual(U.hrStats({ samples: [] }), null, 'empty samples score null');

// In-progress nights: no totals yet, or a get-up time still in the future.
const NOW = new Date(2026, 10, 6, 12, 0); // 2026-11-06 12:00 local
assert.strictEqual(U.nightInProgress({ total_min: 0, get_up: '2026-11-5 23:00' }, NOW), true,
  'zero totals means in progress');
assert.strictEqual(U.nightInProgress({ total_min: 426, get_up: '2026-11-6 6:37' }, NOW), false,
  'past get-up means completed');
assert.strictEqual(U.nightInProgress({ total_min: 120, get_up: '2026-11-6 18:00' }, NOW), true,
  'future get-up means in progress');
assert.strictEqual(U.nightInProgress({ total_min: 426, get_up: '' }, NOW), false,
  'missing get-up with totals is treated as completed');
assert.strictEqual(U.nightInProgress(null, NOW), false, 'null record is not in progress');
assert.deepStrictEqual(
  U.parseNightDateTime('2026-11-6 6:37'),
  new Date(2026, 10, 6, 6, 37),
  'night timestamp parsed as local time');
assert.strictEqual(U.parseNightDateTime('nope'), null, 'bad timestamp is null');

// Goal defaults match the watch setup (8000 steps / 500 kcal).
assert.deepStrictEqual(U.DEFAULT_GOALS, { steps: 8000, kcal: 500 });

// wireMonthNav: ‹/› pager calls onMove with -1/+1.
const pagerClicks = {};
global.document = {
  getElementById: (id) => ({ addEventListener: (ev, fn) => { pagerClicks[id] = fn; } }),
};
const moves = [];
U.wireMonthNav((n) => moves.push(n));
pagerClicks.btnPrevM();
pagerClicks.btnNextM();
assert.deepStrictEqual(moves, [-1, 1]);

console.log('chart.test.js: all assertions passed');
