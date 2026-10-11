// Fail-fast skew guard: every page's need list must resolve against the
// real JS files. Catches the "App files out of sync" class without a phone
// (that banner on-device almost always means stale files — re-download all
// webapp files together). Plain node, no deps: node webapp/skew.test.js
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
global.Store = {
  put: () => Promise.resolve(),
  list: () => Promise.resolve([]),
};

const PAGES = ['index.html', 'activity.html', 'sleep.html', 'workout.html', 'watch.html', 'pull.html'];
const needs = {};
PAGES.forEach((p) => {
  const html = fs.readFileSync(path.join(ROOT, 'webapp', p), 'utf8');
  const m = html.match(/var need = \[([\s\S]*?)\];/);
  assert.ok(m, p + ' has a fail-fast need list');
  needs[p] = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(needs[p].length, p + ' need list is not empty');
});
const allNames = [...new Set([].concat(...Object.values(needs)))];
const probe = allNames
  .map((n) => `__missing.push([${JSON.stringify(n)}, typeof ${n}]);`)
  .join('\n');

eval(
  fs.readFileSync(path.join(ROOT, 'webapp', 'store.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'webapp', 'ble.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'webapp', 'ui.js'), 'utf8') +
    '\nconst __missing = [];\n' + probe +
    '\nglobalThis.SKEW = __missing;'
);
const missing = globalThis.SKEW.filter((row) => row[1] === 'undefined').map((row) => row[0]);
assert.deepStrictEqual(missing, [], 'unresolved need names: ' + missing.join(', '));
console.log('skew.test.js: all ' + allNames.length + ' need names resolve across ' + PAGES.length + ' pages');
