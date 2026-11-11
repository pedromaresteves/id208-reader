/* ID208 sync — capture state + one sync path + one-time setup.
 *
 * Owns the cap* arrays; Store.saveCaptured() does the IndexedDB writes.
 */
var IDO = window.IDO || (window.IDO = {});

var capLive = null, capSleepNights = [], capWorkouts = [];
var capSportDays = [], capHrDays = [], capSpo2 = [], capPress = [];
var lastSleepItems = -1, lastSportItems = -1, lastHrItems = -1, lastWorkoutItems = -1;
var lastSwimItems = -1, lastSpo2Items = -1, lastPressItems = -1;

IDO.sync = (function () {
  'use strict';

  var macroRunning = false;

  function getItems(t) {
    return t === 8 ? lastSportItems : t === 3 ? lastHrItems : t === 7 ? lastSleepItems
      : t === 4 ? lastWorkoutItems : t === 6 ? lastSwimItems : t === 1 ? lastSpo2Items : lastPressItems;
  }
  function setItems(t, v) {
    if (t === 8) lastSportItems = v;
    else if (t === 3) lastHrItems = v;
    else if (t === 7) lastSleepItems = v;
    else if (t === 4) lastWorkoutItems = v;
    else if (t === 6) lastSwimItems = v;
    else if (t === 1) lastSpo2Items = v;
    else lastPressItems = v;
  }

  function resetCaptures() {
    capLive = null;
    capWorkouts = [];
    capSleepNights = [];
    capSportDays = [];
    capHrDays = [];
    capSpo2 = [];
    capPress = [];
  }

  function upsertDay(list, entry) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].date === entry.date) { list[i] = entry; return; }
    }
    list.push(entry);
  }

  function captures() {
    return {
      live: capLive,
      sportDays: capSportDays,
      sleepNights: capSleepNights,
      hrDays: capHrDays,
      workouts: capWorkouts,
      spo2: capSpo2,
      press: capPress,
    };
  }

  function setLive(live) { capLive = live; }

  // Consume one codec.decodeHealth() descriptor. The codec is pure; all
  // state/logging lives here so the pager sees item counts immediately.
  function capture(d) {
    if (!d) return;
    if (d.operate === 0x00) {
      if (d.dataType === 7) lastSleepItems = d.itemCount;
      else if (d.dataType === 8) lastSportItems = d.itemCount;
      else if (d.dataType === 3) lastHrItems = d.itemCount;
      else if (d.dataType === 4) lastWorkoutItems = d.itemCount;
      else if (d.dataType === 6) lastSwimItems = d.itemCount;
      else if (d.dataType === 1) lastSpo2Items = d.itemCount;
      else if (d.dataType === 2) lastPressItems = d.itemCount;
      // Post-reset empty stores can answer with an unknown type and zero
      // items; during sleep paging that still means "no more nights".
      else if (d.itemCount === 0) lastSleepItems = 0;
    }
    if (d.kind === 'stop') { IDO.shell.log(d.message); return; }
    if (d.empty) { IDO.shell.log(d.message); return; }
    if (d.kind === 'sport' && d.record) {
      upsertDay(capSportDays, d.record);
    } else if (d.kind === 'sleep' && d.record) {
      capSleepNights.push(d.record);
    } else if (d.kind === 'hr' && d.record) {
      upsertDay(capHrDays, d.record);
    } else if (d.kind === 'workout' && d.record) {
      capWorkouts.push(d.record);
    } else if (d.kind === 'swim' && d.record) {
      capWorkouts.push(d.record);
    } else if (d.kind === 'spo2' && d.record) {
      upsertDay(capSpo2, d.record);
    } else if (d.kind === 'pressure' && d.record) {
      upsertDay(capPress, d.record);
    }
    IDO.shell.show(d.message);
  }

  async function saveCaptured(tag) {
    try {
      var saved = await Store.saveCaptured(captures(), tag);
      IDO.shell.log('Saved to store [' + tag + ']: ' +
        (saved.length ? saved.join(', ') : 'nothing captured'));
      return saved;
    } catch (e) {
      IDO.shell.log('Store save failed [' + tag + ']: ' + e);
      return [];
    }
  }

  async function autoSyncAfterConnect(opts) {
    opts = opts || {};
    IDO.shell.log('Auto-sync: checking bind state...');
    lastPair = -1;
    await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
    await IDO.transport.wait(3000);
    if (lastPair === 1) {
      IDO.shell.log('Watch bound (pair=1) — starting automatic sync.');
      await syncNow(opts);
    } else if (opts.autoSetup) {
      IDO.shell.show('Watch not bound (pair=' + lastPair + ') — running first-time setup (bind + auth, ~90 s).');
      setProgress(1, 1, 'First-time setup (~90 s)');
      await setupAuto();
      if (lastPair === 1) {
        IDO.shell.log('Setup complete (pair=1) — starting the first sync.');
        await syncNow(opts);
      } else {
        throw new Error('Watch still reports pair=' + lastPair + ' after setup');
      }
    } else {
      IDO.shell.show('Watch not bound (pair=' + lastPair + ') — open Settings → Set up watch first.');
    }
  }

  async function setupAuto() {
    // Replays VeryFit's reinstall-bind order (~90 s total).
    if (macroRunning) {
      IDO.shell.log('A macro is already running — wait for it to finish.');
      return;
    }
    macroRunning = true;
    IDO.shell.setMacroButtons(true);
    try {
      IDO.shell.log('[Setup 1/18] Func table...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x02]));
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 2/18] Func table ex...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x07]));
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 3/18] MTU...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0xF0]));
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 4/18] v3 func table...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildV3FuncTable1A());
      await IDO.transport.wait(3000);
      IDO.shell.log('[Setup 5/18] DND state...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x30]));
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 6/18] Bind (04 01, no tap needed — auth at step 8 finalizes)...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildBindStart());
      await IDO.transport.wait(12000);
      IDO.shell.log('[Setup 7/18] 03 23 (VeryFit sends this between bind and auth)...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildSet23Sample());
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 8/18] Auth 04 05 (challenge XOR MAC — finalizes bind)...');
      var auth = IDO.codec.buildBindAuthPacket();
      if (auth) await IDO.transport.wr(writeChar, '0x0AF6', auth);
      await IDO.transport.wait(3000);
      IDO.shell.log('[Setup 9/18] DND state again...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x30]));
      await IDO.transport.wait(3000);
      IDO.shell.log('[Setup 10/18] Weather switch off...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildWeatherOff());
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 11/18] Goals...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildGoalsSample());
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 12/18] Units...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildUnitsSample());
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 13/18] Device info...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
      await IDO.transport.wait(3000);
      IDO.shell.log('[Setup 14/18] HR mode (x2)...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildHrModeSample());
      await IDO.transport.wait(2000);
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildHrModeSample());
      await IDO.transport.wait(3000);
      IDO.shell.log('[Setup 15/18] Battery...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x05]));
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 16/18] User info...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildUserInfoSample());
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 17/18] Set time (phone clock)...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildSetTimeNow());
      await IDO.transport.wait(2000);
      IDO.shell.log('[Setup 18/18] Device info (check pair=1 above)...');
      await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
      await IDO.transport.wait(3000);
      IDO.shell.show('Setup done — QR should be gone. Tap Sync on the dashboard.');
    } finally {
      macroRunning = false;
      IDO.shell.setMacroButtons(false);
    }
  }

  // Generic cursor-paged pull for COUNT-data (04/06/07): START/STOP at
  // offset 0, stop on items=0 or staleLimit rounds with no new capture.
  async function pageType(dataType, maxRounds, label, staleLimit, freshFn, onRound) {
    var stale = 0;
    for (var r = 0; r < maxRounds; r++) {
      if (onRound) onRound(r + 1, maxRounds);
      var before = freshFn ? freshFn() : 0;
      setItems(dataType, -1);
      IDO.shell.log(label + ' round ' + (r + 1) + '/' + maxRounds + '...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildV3Start04(dataType, 0));
      await IDO.transport.waitFor(function () { return getItems(dataType) >= 0; }, 12000, label + ' reply');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildV3Stop04(dataType));
      await IDO.transport.wait(3000);
      if (getItems(dataType) === 0) { IDO.shell.log(label + ' history empty — paging done.'); break; }
      stale = (freshFn && freshFn() > before) ? 0 : stale + 1;
      if (stale >= staleLimit) { IDO.shell.log(label + ' repeats known records — paging done.'); break; }
    }
  }

  async function pullToday(dataType, label) {
    setItems(dataType, -1);
    await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildV3Start04(dataType, 0));
    await IDO.transport.waitFor(function () { return getItems(dataType) >= 0; }, 12000, label + ' today reply');
    var items = getItems(dataType);
    await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildV3Stop04(dataType));
    await IDO.transport.wait(800);
    IDO.shell.log(label + ' today: items=' + items);
  }

  // Read the watch's live daily summary. Preserve an earlier successful
  // snapshot if this later request gets no reply, so a transient timeout does
  // not discard usable live data.
  async function pullLive(label) {
    var previous = capLive;
    capLive = null;
    IDO.shell.log(label + '...');
    await IDO.transport.wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0xA0]));
    await IDO.transport.waitFor(function () { return capLive !== null; }, 8000, label);
    if (capLive === null && previous !== null) {
      capLive = previous;
      IDO.shell.log(label + ' had no reply — keeping the earlier live snapshot.');
    }
    return capLive;
  }

  async function pageDayHistory(dataType, label, maxRounds, freshFn, onRound) {
    var stale = 0;
    for (var r = 0; r < maxRounds; r++) {
      if (onRound) onRound(r + 1, maxRounds);
      var before = freshFn ? freshFn() : 0;
      setItems(dataType, -1);
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildV3Start04(dataType, 0, 0));
      await IDO.transport.waitFor(function () { return getItems(dataType) >= 0; }, 12000, label + ' history reply');
      var items = getItems(dataType);
      if (items < 0) { IDO.shell.log(label + ' history: no reply — stopping (no STOP sent).'); break; }
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildV3Stop04(dataType, 0));
      await IDO.transport.wait(1000);
      if (items === 0) { IDO.shell.log(label + ' history: no more completed days — done.'); break; }
      var fresh = freshFn ? freshFn() : 0;
      IDO.shell.log(label + ' history round ' + (r + 1) + ': items=' + items + ' (captured ' + fresh + ')');
      stale = (fresh > before) ? 0 : stale + 1;
      if (stale >= 2) { IDO.shell.log(label + ' history repeats the same day — stopping.'); break; }
    }
  }

  // The one sync path (dashboard Sync, Diagnostics Connect auto-sync and Full
  // sync). Pulls today then drains the completed-day cursor to items=0.
  async function syncNow(opts) {
    opts = opts || {};
    if (macroRunning) {
      IDO.shell.log('A macro is already running — wait for it to finish.');
      return;
    }
    macroRunning = true;
    IDO.shell.setMacroButtons(true);
    resetCaptures();
    var lastDay = await Store.getLastSyncDay();
    if (lastDay) {
      IDO.shell.log('Last sync ' + lastDay + ' (' + dayDiff(lastDay, todayStr()) +
        'd ago) — draining the completed-day queue.');
    } else {
      IDO.shell.log('No previous sync stamp — pulling today + every queued completed day.');
    }
    var historyCap = 60;
    var countRounds = opts.deep ? 30 : 8;
    try {
      IDO.shell.log('[Sync 0/8] Sync time (phone clock)...');
      await IDO.transport.wr(writeChar, '0x0AF6', IDO.codec.buildSetTimeNow());
      await IDO.transport.wait(2000);
      setProgress(1, 8, 'Live data');
      await pullLive('[Sync 1/8] Initial live data');
      setProgress(2, 8, 'Sport days');
      IDO.shell.log('[Sync 2/8] Sport days (today + completed-day cursor)...');
      await pullToday(8, 'Sport');
      await pageDayHistory(8, 'Sport', historyCap, function () { return capSportDays.length; },
        function (r) { setProgress(2, 8, 'Sport day ' + r); });
      setProgress(3, 8, 'Sleep');
      IDO.shell.log('[Sync 3/8] Sleep nights (cursor-paged)...');
      await pageType(7, countRounds, 'Sleep', 3, function () { return capSleepNights.length; },
        function (r) { setProgress(3, 8, 'Sleep round ' + r); });
      setProgress(4, 8, 'HR days');
      IDO.shell.log('[Sync 4/8] Heart-rate days (today + completed-day cursor)...');
      await pullToday(3, 'HR');
      await pageDayHistory(3, 'HR', historyCap, function () { return capHrDays.length; },
        function (r) { setProgress(4, 8, 'HR day ' + r); });
      setProgress(5, 8, 'Workouts');
      IDO.shell.log('[Sync 5/8] Workouts (cursor-paged)...');
      await pageType(4, countRounds, 'Workout', 3, function () { return capWorkouts.length; },
        function (r) { setProgress(5, 8, 'Workout round ' + r); });
      setProgress(6, 8, 'Swims');
      IDO.shell.log('[Sync 6/8] Swims (cursor-paged)...');
      await pageType(6, countRounds, 'Swim', 3, function () { return capWorkouts.length; },
        function (r) { setProgress(6, 8, 'Swim round ' + r); });
      setProgress(7, 8, 'SpO2');
      IDO.shell.log('[Sync 7/8] SpO2 days (today + completed-day cursor)...');
      await pullToday(1, 'SpO2');
      await pageDayHistory(1, 'SpO2', historyCap, function () { return capSpo2.length; },
        function (r) { setProgress(7, 8, 'SpO2 day ' + r); });
      setProgress(8, 8, 'Pressure');
      IDO.shell.log('[Sync 8/8] Pressure days (today + completed-day cursor)...');
      await pullToday(2, 'Pressure');
      await pageDayHistory(2, 'Pressure', historyCap, function () { return capPress.length; },
        function (r) { setProgress(8, 8, 'Pressure day ' + r); });
      setProgress(8, 8, 'Final live data');
      await pullLive('[Sync 8/8] Final live data');
      await saveCaptured((opts.deep ? 'full ' : 'daily ') + todayStr());
      IDO.shell.show((opts.deep ? 'Full sync done' : 'Daily sync done') +
        ' — everything saved. <a href="index.html">Open dashboard →</a> (JSONL download kept as audit trail).');
    } finally {
      macroRunning = false;
      IDO.shell.setMacroButtons(false);
    }
  }

  function syncAll() { return syncNow({ deep: true }); }

  return {
    resetCaptures: resetCaptures,
    upsertDay: upsertDay,
    captures: captures,
    setLive: setLive,
    capture: capture,
    saveCaptured: saveCaptured,
    autoSyncAfterConnect: autoSyncAfterConnect,
    setupAuto: setupAuto,
    pageType: pageType,
    pullToday: pullToday,
    pageDayHistory: pageDayHistory,
    syncNow: syncNow,
    syncAll: syncAll,
    getItems: getItems,
  };
})();
