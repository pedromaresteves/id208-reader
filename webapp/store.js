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

  // Classify one decoded record by its fields (pure, no storage).
  // Returns 'steps' | 'sleep' | 'hr' | 'workout' | null.
  // Accepts both phone shapes (durationsS/startS/samples) and sync.py
  // shapes (durations_s/start_time_s/hr_samples) — same data, two dialects.
  function classifyRecord(r) {
    if (!r || typeof r !== 'object') return null;
    if (typeof r.night === 'string') return 'sleep';
    if (
      typeof r.durations_s === 'number' ||
      typeof r.durationsS === 'number' ||
      typeof r.startS === 'number'
    ) {
      return 'workout';
    }
    if (Array.isArray(r.samples)) return 'hr';
    if (typeof r.date === 'string' && r.steps !== undefined) return 'steps';
    return null;
  }

  // Normalize a workout record to phone shape (pure). sync.py rows keep
  // their fields; JS aliases are added (durationsS, startS, avg/max/minHr,
  // distanceM) and plain bpm arrays become [{t, bpm}] pairs (~5 s spacing,
  // matching the watch encoding). Phone-shaped rows pass through untouched.
  function normalizeWorkout(r) {
    if (!r || typeof r !== 'object' || r.durationsS !== undefined) return r;
    var start = r.start_time_s || r.startS || 0;
    var raw = Array.isArray(r.hr_samples) ? r.hr_samples : r.samples || [];
    var samples = raw.map(function (s, i) {
      if (s && typeof s === 'object') {
        return {
          t: s.t_s !== undefined ? s.t_s : s.t !== undefined ? s.t : start + i * 5,
          bpm: s.bpm,
        };
      }
      return { t: start + i * 5, bpm: s };
    });
    var o = {};
    for (var k in r) o[k] = r[k];
    o.startS = start;
    o.durationsS = r.durations_s;
    o.avgHr = r.avgHr !== undefined ? r.avgHr : r.avg_hr;
    o.maxHr = r.maxHr !== undefined ? r.maxHr : r.max_hr;
    o.minHr = r.minHr !== undefined ? r.minHr : r.min_hr;
    o.distanceM = r.distanceM !== undefined ? r.distanceM : r.distance_m;
    o.samples = samples;
    return o;
  }

  // Split a bare array of decoded records into per-type groups (pure).
  function groupRecords(records) {
    var groups = { steps: [], sleep: [], hr: [], workout: [] };
    (records || []).forEach(function (r) {
      var t = classifyRecord(r);
      if (!t) return;
      groups[t].push(t === 'workout' ? normalizeWorkout(r) : r);
    });
    return groups;
  }

  // Parse a steps.csv text into step records (pure). Throws on bad input.
  function parseCsvSteps(text) {
    var lines = String(text).split(/\r?\n/).filter(function (l) {
      return l.trim() !== '';
    });
    if (lines.length < 2) throw new Error('empty CSV');
    var head = lines[0].split(',').map(function (c) { return c.trim(); });
    function col(name) { return head.indexOf(name); }
    if (col('date') < 0 || col('steps') < 0) throw new Error('not a steps.csv');
    function numAt(cells, name) {
      var i = col(name);
      if (i < 0 || cells[i] === undefined || cells[i].trim() === '') return '';
      var n = Number(cells[i]);
      return isNaN(n) ? cells[i].trim() : n;
    }
    var out = [];
    lines.slice(1).forEach(function (ln) {
      var cells = ln.split(',');
      var date = cells[col('date')].trim();
      if (!date) return;
      out.push({
        date: date,
        steps: numAt(cells, 'steps'),
        distance_m: numAt(cells, 'distance_m'),
        kcal: numAt(cells, 'kcal'),
        active_min: numAt(cells, 'active_min'),
        source: col('source') >= 0 ? cells[col('source')].trim() : 'steps.csv import',
      });
    });
    return out;
  }

  function writeGroups(groups) {
    var counts = { steps: 0, sleep: 0, hr: 0, workout: 0 };
    var writes = [];
    function queue(type, date, payload) {
      counts[type] += 1;
      writes.push(put(date, type, payload, payload.source));
    }
    groups.steps.forEach(function (r) { if (r.date) queue('steps', r.date, r); });
    groups.sleep.forEach(function (n) { if (n.night) queue('sleep', n.night, n); });
    groups.hr.forEach(function (d) { if (d.date) queue('hr', d.date, d); });
    groups.workout.forEach(function (w, i) {
      queue('workout', w.date || ('no-date-' + i), w);
    });
    return Promise.all(writes).then(function () { return counts; });
  }

  // Route anything importable into per-type groups (pure, no storage).
  // Accepts store-backup {rows}, combined {steps,sleep,hr,workouts}, bare
  // JSON array (classified per record). Throws on garbage.
  function routeInput(doc) {
    if (doc && Array.isArray(doc.rows)) {
      var direct = { steps: [], sleep: [], hr: [], workout: [] };
      doc.rows.forEach(function (r) {
        if (r && r.date && r.type && direct[r.type]) direct[r.type].push(r.payload || r);
      });
      return direct;
    }
    if (Array.isArray(doc)) return groupRecords(doc);
    if (doc && typeof doc === 'object') {
      return {
        steps: doc.steps || [],
        sleep: doc.sleep || [],
        hr: doc.hr || [],
        workout: doc.workouts || doc.workout || [],
      };
    }
    throw new Error('unrecognized JSON');
  }

  // Accept anything importable and write it, resolving per-type counts:
  // store-backup {rows}, combined {steps,sleep,hr,workouts}, bare JSON array
  // (classified per record), or steps.csv text. Throws on garbage.
  async function importText(text) {
    var trimmed = String(text).trim();
    if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
      return writeGroups(routeInput(JSON.parse(trimmed)));
    }
    return writeGroups({ steps: parseCsvSteps(trimmed), sleep: [], hr: [], workout: [] });
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
    classifyRecord: classifyRecord,
    normalizeWorkout: normalizeWorkout,
    groupRecords: groupRecords,
    routeInput: routeInput,
    parseCsvSteps: parseCsvSteps,
    importText: importText,
  };
})();
