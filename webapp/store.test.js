// store.js import-routing tests. Plain node, no deps:
//   node webapp/store.test.js
// Uses the real decoded out/ files as fixtures.

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

global.window = {};
const ROOT = path.resolve(__dirname, '..');
eval(
  fs.readFileSync(path.join(ROOT, 'webapp', 'store.js'), 'utf8') +
    '\nglobalThis.Store = Store;'
);
const Store = globalThis.Store;

const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'out', f), 'utf8'));
const sleep = readJSON('sleep.json');
const hr = readJSON('hr.json');
const workouts = readJSON('workouts.json');
const stepsCsv = fs.readFileSync(path.join(ROOT, 'out', 'steps.csv'), 'utf8');

// classifyRecord spots each shape (phone + sync.py dialects).
assert.strictEqual(Store.classifyRecord(sleep[0]), 'sleep');
assert.strictEqual(Store.classifyRecord(hr[0]), 'hr');
assert.strictEqual(Store.classifyRecord(workouts[0]), 'workout');
assert.strictEqual(
  Store.classifyRecord({ date: '2026-10-08', durationsS: 1, startS: 2 }),
  'workout'
);
assert.strictEqual(Store.classifyRecord({ date: '2026-10-08', steps: 1 }), 'steps');
assert.strictEqual(Store.classifyRecord({}), null);
assert.strictEqual(Store.classifyRecord(null), null);

// sync.py workout rows normalize to phone shape (aliases + bpm pairs).
const norm = Store.normalizeWorkout(workouts[0]);
assert.strictEqual(norm.durationsS, workouts[0].durations_s);
assert.strictEqual(norm.startS, workouts[0].start_time_s);
assert.strictEqual(norm.avgHr, workouts[0].avg_hr);
assert.strictEqual(norm.distanceM, workouts[0].distance_m);
assert.strictEqual(norm.samples.length, workouts[0].hr_samples.length);
assert.strictEqual(norm.samples[0].bpm, workouts[0].hr_samples[0]);
assert.strictEqual(
  norm.samples[0].t,
  workouts[0].start_time_s
);
// Phone-shaped rows pass through untouched.
const asIs = { durationsS: 5, startS: 6 };
assert.strictEqual(Store.normalizeWorkout(asIs), asIs);

// Bare arrays route whole, nothing lost.
let g = Store.routeInput(sleep);
assert.strictEqual(g.sleep.length, sleep.length);
assert.deepStrictEqual([g.steps.length, g.hr.length, g.workout.length], [0, 0, 0]);
g = Store.routeInput(hr);
assert.strictEqual(g.hr.length, hr.length);
g = Store.routeInput(workouts);
assert.strictEqual(g.workout.length, workouts.length);

// Combined + backup shapes.
g = Store.routeInput({ steps: [], sleep: sleep, hr: [], workouts: workouts });
assert.strictEqual(g.sleep.length, sleep.length);
assert.strictEqual(g.workout.length, workouts.length);
g = Store.routeInput({ rows: [{ date: '2026-10-08', type: 'sleep', payload: sleep[0] }] });
assert.strictEqual(g.sleep.length, 1);

// steps.csv parses; first data row matches the file.
const rows = Store.parseCsvSteps(stepsCsv);
const csvLines = stepsCsv.trim().split('\n');
assert.ok(rows.length === csvLines.length - 1, 'all csv rows parsed');
assert.strictEqual(rows[0].date, csvLines[1].split(',')[0]);
assert.strictEqual(typeof rows[0].steps, 'number');

// Garbage throws.
assert.throws(() => Store.routeInput(42), /unrecognized/);
assert.throws(() => Store.parseCsvSteps('just some text'), /steps\.csv|empty/);

console.log('store.test.js: all assertions passed');
