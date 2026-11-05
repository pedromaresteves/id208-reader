// Shared Node harness for capture/parity tests: DOM + fake Store, then load
// the real browser modules (shell, ui, codec, transport, sync).
'use strict';
const fs = require('fs');
const path = require('path');

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

function load() {
  global.window = {};
  const els = {};
  global.document = {
    readyState: 'loading',
    getElementById: (id) => (els[id] || (els[id] = makeEl())),
    createElement: () => makeEl(),
    createTextNode: (t) => ({ text: t }),
    querySelector: () => null,
    addEventListener: () => {},
    body: makeEl(),
  };

  const puts = [];
  function put(date, type, payload) {
    puts.push({ date, type, payload });
    return Promise.resolve();
  }
  function saveCaptured(captures, tag) {
    const saved = [];
    const c = captures || {};
    (c.sportDays || []).forEach((sd) => {
      put(sd.date, 'steps', {
        date: sd.date, steps: sd.steps, distance_m: sd.distanceM,
        kcal: sd.displayKcal !== null ? sd.displayKcal : '',
        active_min: sd.activeMin !== null ? sd.activeMin : '',
      });
    });
    if ((c.sportDays || []).length) saved.push(c.sportDays.length + ' step day(s)');
    else if (c.live) {
      const today = todayStr();
      put(today, 'steps', {
        date: today, steps: c.live.steps, distance_m: c.live.distanceM,
        kcal: '', active_min: '',
      });
      saved.push('steps(live)');
    }
    (c.sleepNights || []).forEach((n) => {
      put(n.night, 'sleep', {
        night: n.night, fall_asleep: n.fallAsleep, get_up: n.getUp,
        total_min: n.tot, wake_min: n.wake, light_min: n.light,
        rem_min: n.rem, deep_min: n.deep,
      });
    });
    if ((c.sleepNights || []).length) saved.push(c.sleepNights.length + ' night(s)');
    (c.hrDays || []).forEach((hd) => {
      put(hd.date, 'hr', {
        date: hd.date, start_time_s: hd.startS, silent_hr: hd.silent,
        zones: hd.zones, samples: hd.samples,
      });
    });
    if ((c.hrDays || []).length) saved.push(c.hrDays.length + ' HR day(s)');
    (c.workouts || []).forEach((w) => {
      put(w.date + ' ' + w.startS, 'workout', w);
    });
    if ((c.workouts || []).length) saved.push(c.workouts.length + ' workout(s)');
    [['spo2', c.spo2 || []], ['pressure', c.press || []]].forEach(([type, rows]) => {
      rows.forEach((r) => put(r.date || 'raw', type, r));
      if (rows.length) saved.push(rows.length + ' ' + type + ' record(s)');
    });
    if (saved.length) {
      put('last-sync', 'meta', { day: todayStr(), at: new Date().toISOString(), tag: tag || '' });
    }
    return Promise.resolve(saved);
  }

  global.Store = {
    put,
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    getLastSyncDay: () => Promise.resolve(null),
    saveCaptured,
  };

  const files = ['shell.js', 'ui.js', 'codec.js', 'transport.js', 'sync.js'];
  let source = files
    .map((f) => fs.readFileSync(path.join(ROOT, 'webapp', f), 'utf8'))
    .join('\n') + '\nglobalThis.IDO = IDO; globalThis.todayStr = todayStr; globalThis.dayDiff = dayDiff;';
  eval(source);
  return { IDO: globalThis.IDO, puts };
}

module.exports = { load, ROOT };
