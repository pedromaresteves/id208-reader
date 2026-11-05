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
  function fakePut(date, type, payload) {
    puts.push({ date, type, payload });
    return Promise.resolve();
  }
  function fakeStamp(day, tag) {
    puts.push({
      date: 'last-sync',
      type: 'meta',
      payload: { day, at: new Date().toISOString(), tag: tag || '' },
    });
    return Promise.resolve();
  }

  // Load the real browser modules. store.js is the real implementation; the
  // harness only injects a writer/stamp so saveCaptured is exercised without
  // IndexedDB (never reimplemented here).
  const files = ['shell.js', 'ui.js', 'store.js', 'codec.js', 'transport.js', 'sync.js'];
  const source = files
    .map((f) => fs.readFileSync(path.join(ROOT, 'webapp', f), 'utf8'))
    .join('\n') + '\nglobalThis.IDO = IDO; globalThis.Store = Store;' +
    ' globalThis.todayStr = todayStr; globalThis.dayDiff = dayDiff;';
  eval(source);

  const store = globalThis.Store;
  const realSave = store.saveCaptured;
  store.list = () => Promise.resolve([]);
  store.get = () => Promise.resolve(null);
  store.getLastSyncDay = () => Promise.resolve(null);
  store.saveCaptured = (captures, tag, options) => realSave(
    captures,
    tag,
    Object.assign({ write: fakePut, stamp: fakeStamp, quiet: true }, options || {}),
  );
  globalThis.Store = store;

  return { IDO: globalThis.IDO, puts };
}

module.exports = { load, ROOT };
