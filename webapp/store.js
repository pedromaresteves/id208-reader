/* id208-reader local store — framework-free IndexedDB wrapper.
 *
 * One record per (date, type): { date, type, payload, source, updatedAt }.
 * Types: 'steps' | 'sleep' | 'hr' | 'workout'. Dates are YYYY-MM-DD
 * (sleep uses its night date). Newer pulls overwrite the same key, so
 * history grows by date, never duplicates. No network, no account.
 */

var Store = (function () {
  'use strict';
  var DB_NAME = 'id208-reader';
  var DB_VERSION = 1;
  var STORE = 'records';
  var dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = window.indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = function () { reject(req.error); };
        req.onsuccess = function () { resolve(req.result); };
        req.onupgradeneeded = function () {
          var db = req.result;
          var store = db.createObjectStore(STORE, { keyPath: ['date', 'type'] });
          store.createIndex('by-type-date', ['type', 'date'], { unique: false });
        };
      });
    }
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function put(date, type, payload, source) {
    return tx('readwrite', function (store) {
      return store.put({
        date: date,
        type: type,
        payload: payload,
        source: source || '',
        updatedAt: new Date().toISOString(),
      });
    });
  }

  function get(date, type) {
    return tx('readonly', function (store) {
      return store.get([date, type]);
    });
  }

  // All records of one type, oldest first; optional { from, to } YYYY-MM-DD.
  function list(type, range) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var t = db.transaction(STORE, 'readonly');
        var idx = t.objectStore(STORE).index('by-type-date');
        var keyRange = null;
        if (range && (range.from || range.to)) {
          keyRange = window.IDBKeyRange.bound(
            [type, range.from || ''],
            [type, range.to || '\uffff']
          );
        } else {
          keyRange = window.IDBKeyRange.bound([type, ''], [type, '\uffff']);
        }
        var cursor = idx.openCursor(keyRange);
        cursor.onsuccess = function () {
          var c = cursor.result;
          if (c) { out.push(c.value); c.continue(); }
          else resolve(out);
        };
        cursor.onerror = function () { reject(cursor.error); };
      });
    });
  }

  function clear() {
    return tx('readwrite', function (store) { return store.clear(); });
  }

  function exportJSON() {
    return tx('readonly', function (store) {
      return store.getAll();
    }).then(function (rows) {
      return JSON.stringify({ app: 'id208-reader', version: 1, rows: rows });
    });
  }

  function importJSON(text) {
    var doc = JSON.parse(text);
    if (!doc || !Array.isArray(doc.rows)) throw new Error('not a store export');
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        var store = t.objectStore(STORE);
        doc.rows.forEach(function (r) {
          if (r && r.date && r.type) store.put(r);
        });
        t.oncomplete = function () { resolve(doc.rows.length); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  // Seed from sync.py outputs (out/steps.csv rows + sleep/hr/workouts arrays).
  // Returns the number of records written.
  function seedFromOut(out) {
    var writes = [];
    (out.steps || []).forEach(function (r) {
      if (r.date) writes.push(put(r.date, 'steps', r, r.source));
    });
    (out.sleep || []).forEach(function (n) {
      if (n.night) writes.push(put(n.night, 'sleep', n, n.source));
    });
    (out.hr || []).forEach(function (d) {
      if (d.date) writes.push(put(d.date, 'hr', d, d.source));
    });
    (out.workouts || []).forEach(function (w, i) {
      var key = w.date || ('no-date-' + i);
      writes.push(put(key, 'workout', w, w.source));
    });
    return Promise.all(writes).then(function () { return writes.length; });
  }

  return {
    open: open,
    put: put,
    get: get,
    list: list,
    clear: clear,
    exportJSON: exportJSON,
    importJSON: importJSON,
    seedFromOut: seedFromOut,
  };
})();
