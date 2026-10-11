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
    '\nglobalThis.U = { stackedBarChart, barAt, setupCanvas, fmtHM, kmOrDash,' +
    ' monthKey, addMonths, daysInMonth, addDays, mondayOf, weeksOf, sleepScore, DEFAULT_GOALS,' +
    ' wireMonthNav, isoWeek };'
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

// fmtHM sanity.
assert.strictEqual(U.fmtHM(425), '7h05m');
assert.strictEqual(U.fmtHM(0), '0h00m');

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
