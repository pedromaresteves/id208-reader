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
    '\nglobalThis.U = { stackedBarChart, barAt, setupCanvas, fmtHM };'
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

console.log('chart.test.js: all assertions passed');
