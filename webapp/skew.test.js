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
    firstChild: null,
    addEventListener() {},
    appendChild() {},
    insertBefore() {},
  };
}
global.window = {};
const __els = {};
global.document = {
  readyState: 'loading',
  getElementById: (id) => (__els[id] || (__els[id] = makeEl())),
  createElement: () => makeEl(),
  createTextNode: (t) => ({ text: t }),
  querySelector: () => null,
  addEventListener: () => {},
  body: makeEl(),
};
// NOTE: no navigator stub — node 22 ships a read-only global one; the
// transport only touches navigator inside connectAndSync (never exercised).
global.Store = {
  put: () => Promise.resolve(),
  list: () => Promise.resolve([]),
};

const PAGES = ['index.html', 'activity.html', 'sleep.html', 'workout.html', 'watch.html', 'diagnostics.html'];
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
  .map((n) => n.includes('.')
    ? `__missing.push([${JSON.stringify(n)}, IDO.shell.hasPath(${JSON.stringify(n)})]);`
    : `__missing.push([${JSON.stringify(n)}, typeof ${n} !== 'undefined']);`)
  .join('\n');

eval(
  fs.readFileSync(path.join(ROOT, 'webapp', 'shell.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'webapp', 'store.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'webapp', 'ui.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'webapp', 'codec.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'webapp', 'transport.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'webapp', 'sync.js'), 'utf8') +
    '\nconst __missing = [];\n' + probe +
    '\nglobalThis.SKEW = __missing;'
);
const missing = globalThis.SKEW.filter((row) => !row[1]).map((row) => row[0]);
assert.deepStrictEqual(missing, [], 'unresolved need names: ' + missing.join(', '));

// The guard must also fire, not just resolve: a missing name inserts the
// banner (naming only that name) and throws so the page's wiring stops.
const inserted = [];
global.document.body.insertBefore = (el) => { inserted.push(el); };
let halted = null;
try {
  window.IDO.shell.checkFiles(['IDO.transport', 'IDO.nope.missing']);
} catch (e) {
  halted = e.message;
}
assert.strictEqual(inserted.length, 1, 'one banner inserted');
assert.match(inserted[0].textContent, /App files out of sync/, 'banner headline');
assert.match(inserted[0].textContent, /IDO\.nope\.missing/, 'banner names the missing path');
assert.ok(
  !inserted[0].textContent.includes('IDO.transport'),
  'banner omits paths that resolve',
);
assert.match(halted, /^halt: /, 'checkFiles throws after inserting the banner');

inserted.length = 0;
window.IDO.shell.checkFiles(['IDO.transport', 'IDO.codec']);
assert.strictEqual(inserted.length, 0, 'no banner when every name resolves');

console.log(
  'skew.test.js: all ' + allNames.length + ' need names resolve across ' +
    PAGES.length + ' pages, and the banner fires on a missing one',
);
