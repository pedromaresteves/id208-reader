/* ID208 shared BLE core — included by diagnostics.html, index.html and watch.html.
 *
 * Holds ALL watch protocol code: GATT transport, packet builders, v3
 * reassembly, legato handlers, capture vars, one-tap macros, store saving.
 * Page-specific DOM wiring (buttons, log panes, dashboard) lives in each
 * page's own inline script. Contract:
 * - log/show/record write to #log/#events/#decoded when present, else console.
 * - setProgress(done,total,label): override per page (default logs only).
 * - PAGE_BASIC_BUTTONS / PAGE_FULL_BUTTONS: set by each page; enableIds skips missing.
 * - connectAndSync({noAuto}) returns a promise resolving when done.
 */
// Wire map (d3nd3/toobur-veryfit-research A200-PROTOCOL.md Transport):
// 0x0AF6 write -> 0x0AF7 notify (legacy GET 0x02.. + short v3 <=50B incl. 19B 0x04 START/STOP).
// 0x0AF1 write -> 0x0AF2 notify (large v3 >50B: 137B 0x05 sizes). Listen for v3 on BOTH notifies.
var writeChar, notifyChar, healthWriteChar, healthNotifyChar;
var v3Seq = 0x60; // start above logcat template seqs to avoid collisions in one session
var rxBuf = null, rxWritten = 0;
var lines = []; // {ts, char, dir, hex}
function log(msg) {
  try { console.log(msg); } catch (e) {}
  var logEl = document.getElementById('log');
  if (!logEl) return;
  logEl.textContent += msg + '\n';
  var d = document.createElement('div');
  d.appendChild(document.createTextNode(msg));
  document.getElementById('events').appendChild(d);
}
function hexStr(arr) { return Array.from(arr, function (b) { return b.toString(16).padStart(2, '0').toUpperCase(); }).join(' '); }
function record(char, dir, arr) {
  lines.push({ ts: new Date().toISOString(), char: char, dir: dir, hex: hexStr(arr).replace(/ /g, '') });
  log((dir === 'TX' ? 'TX : ' : 'RX : ') + hexStr(arr) + '  [' + char + ']');
}
function parseHex(s) {
  var t = s.trim().split(/[\s:]+/);
  var out = new Uint8Array(t.length);
  for (var i = 0; i < t.length; i++) out[i] = parseInt(t[i], 16);
  return out;
}
function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
// CRC-16-CCITT-FALSE (poly 0x1021, init 0xFFFF), over bytes [1..len-3], stored LE.
function crc16Ccitt(buf, off, len) {
  var crc = 0xFFFF;
  for (var i = off; i < off + len; i++) {
    crc ^= buf[i] << 8;
    for (var k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    crc &= 0xFFFF;
  }
  return crc;
}
// v3 0x05 sizes query: 137 B wire. 7 type+offset records (SpO2,pressure,HR,activity,swim,sleep,sport),
// pad with zeros; CRC over [1..len-3]. offsets maps dataType -> 32-bit byte offset (default 0).
// VeryFit sends the SAME per-type offset in both 0x05 and the following 0x04 START — the watch
// uses the 0x05 offset to set its internal resume position, so to page history we must re-send
// 0x05 with the current byte offset before each 0x04 START (d3nd3/toobur-veryfit-research
// sync_example.txt: sport offset 0x4E in both 0x05 and 0x04).
function buildV3Sizes05(offsets) {
  var types = [0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x08];
  var pkt = new Uint8Array(137);
  pkt[0] = 0x33; pkt[1] = 0xDA; pkt[2] = 0xAD; pkt[3] = 0xDA; pkt[4] = 0xAD;
  pkt[5] = 0x01; pkt[6] = 0x88; pkt[7] = 0x00; pkt[8] = 0x05; pkt[9] = 0x00;
  pkt[10] = v3Seq & 0xFF; pkt[11] = (v3Seq >> 8) & 0xFF; v3Seq++;
  var o = 12;
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var off = (offsets && offsets[t]) || 0;
    pkt[o++] = t;
    pkt[o++] = off & 0xFF; pkt[o++] = (off >> 8) & 0xFF;
    pkt[o++] = (off >> 16) & 0xFF; pkt[o++] = (off >> 24) & 0xFF;
  }
  var crc = crc16Ccitt(pkt, 1, pkt.length - 3);
  pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
  return pkt;
}
// v3 0x04 START per type: 19 B wire. byte14 = 0x01 day-data (01,02,03,08), 0x00 count-data (04,06,07).
// bytes 15-16 LE = saveOffset: a BYTE position in that type's stored stream
// (d3nd3/toobur-veryfit-research LATEST_SYNC_PARSING.md; VeryFit resumes sport
// at byte offsets like 0x4E).
// LIVE 2026-11-04 (Windows bond, writes only possible on 0x0AF6): saveOffset
// is IGNORED for day-data on 0x0AF6 — byte14=1 returns today's record at ANY
// offset (replies byte-identical except seq), byte14=0 returns the same single
// oldest record (2026-10-30) at any offset, and repeated STARTs do not advance
// a cursor. Day-data history is driven by the watch cursor (pageDayHistory).
var BYTE14 = { 1: 1, 2: 1, 3: 1, 4: 0, 6: 0, 7: 0, 8: 1 };
function buildV3Start04(dataType, offset, b14Override) {
  var pkt = new Uint8Array(19);
  pkt[0] = 0x33; pkt[1] = 0xDA; pkt[2] = 0xAD; pkt[3] = 0xDA; pkt[4] = 0xAD;
  pkt[5] = 0x01; pkt[6] = 0x10; pkt[7] = 0x00; pkt[8] = 0x04; pkt[9] = 0x00;
  pkt[10] = v3Seq & 0xFF; pkt[11] = (v3Seq >> 8) & 0xFF; v3Seq++;
  pkt[12] = 0x00; pkt[13] = dataType;
  pkt[14] = (b14Override === undefined || b14Override === null) ? BYTE14[dataType] : b14Override;
  pkt[15] = (offset || 0) & 0xFF; pkt[16] = ((offset || 0) >> 8) & 0xFF;
  var crc = crc16Ccitt(pkt, 1, pkt.length - 3);
  pkt[17] = crc & 0xFF; pkt[18] = (crc >> 8) & 0xFF;
  return pkt;
}
function v3TotalLen(first) { return first[6] | (first[7] << 8); }
// Bind / setup (0x0AF6 write -> 0x0AF7 notify, no account).
// BIND_START live-verified on A200 (bind-v3.json): TX 04 01 F1... -> RX 04 01 00 00.
// SET time from VeryFit logcat set_time.txt: 03 01 + yearLE + MM DD hh mm ss weekday + 6 zeros.
// User info from fresh-launch: 03 10 B4 40 1F 00 D6 07 03 01 (sample clears setup gate).
function buildBindStart() { return new Uint8Array([0x04, 0x01, 0xF1, 0x01, 0x01, 0x02, 0x02, 0x01, 0x00]); }
function buildBindStop() { return new Uint8Array([0x04, 0x02, 0xF1, 0x01, 0x01, 0x02, 0x02, 0x01, 0x00]); }
// 03 23 02 00: VeryFit sends this between bind and auth (purpose unknown).
function buildSet23Sample() { return new Uint8Array([0x03, 0x23, 0x02, 0x00]); }
// 04 05 encrypted auth (16 B): the step that finalizes binding (solved
// 2026-10-08, captures/veryfit-bind-2026-10-08.log #26-32 + reset-test proof).
// Layout: 04 05 0C 00 + challenge[6] + (challenge XOR watchMAC)[6];
// challenge + MAC both come from the 04 01 reply. Reply 04 05 00 00 =
// accepted (pair flips 0 -> 1); 04 05 02 00 = rejected (stale challenge or
// wrong seal — random trailing bytes are rejected, proven 2026-10-08).
var bindChallenge = null, bindMac = null; // captured from the 04 01 reply
function buildBindAuthPacket() {
  if (!bindChallenge || !bindMac) {
    log('No 04 01 challenge captured yet — run Bind (step 6) first');
    return null;
  }
  var pkt = new Uint8Array(16);
  pkt[0] = 0x04; pkt[1] = 0x05; pkt[2] = 0x0C; pkt[3] = 0x00;
  pkt.set(bindChallenge.subarray(0, 6), 4);
  for (var i = 0; i < 6; i++) pkt[10 + i] = bindChallenge[i] ^ bindMac[i];
  return pkt;
}
function buildSetTimeNow() {
  var n = new Date();
  var pkt = new Uint8Array(16);
  pkt[0] = 0x03; pkt[1] = 0x01;
  pkt[2] = n.getFullYear() & 0xFF; pkt[3] = (n.getFullYear() >> 8) & 0xFF;
  pkt[4] = n.getMonth() + 1; pkt[5] = n.getDate();
  pkt[6] = n.getHours(); pkt[7] = n.getMinutes(); pkt[8] = n.getSeconds();
  pkt[9] = (n.getDay() + 6) % 7 + 1; // Mon=1..Sun=7
  return pkt;
}
function buildUserInfoSample() { return new Uint8Array([0x03, 0x10, 0xB4, 0x40, 0x1F, 0x00, 0xD6, 0x07, 0x03, 0x01]); }
// Post-bind prelude from VeryFit fresh-launch logcat: the watch stays on its
// QR setup screen until it gets units + goals + weather switch, not just bind.
// Units 17B, calorie+distance goals 20B, weather-off 6B (all byte-identical).
function buildUnitsSample() { return parseHex('03 11 01 01 01 00 02 01 00 00 00 01 01 01 01 00 00'); }
function buildGoalsSample() { return parseHex('03 43 F4 01 00 00 00 00 00 00 08 07 00 00 FA 00 0E 06 0C 00'); }
function buildWeatherOff() { return new Uint8Array([0x03, 0x2D, 0x55, 0x00, 0x00, 0x00]); }
// Auto activity/sport detection (SET 03 49, 11 B): flags walk, run,
// bicycle, auto_pause, auto_end_remind, elliptical, rowing, swim, smart_rope.
// Matches Gadgetbridge-veryfit TooburAutoActivitySwitchPackets captures.
function buildAutoActivity(flags) {
  var pkt = new Uint8Array(11);
  pkt[0] = 0x03; pkt[1] = 0x49;
  for (var i = 0; i < 9; i++) pkt[2 + i] = (flags && flags[i]) ? 0x01 : 0x00;
  return pkt;
}
// v3 0x1A func-table query (14 B) and 0x09 HR-mode (26 B): payloads transplanted
// from the reinstall-bind logcat, seq refreshed, CRC recomputed. Both <=50 B
// so they go on 0x0AF6 like the other short v3 frames.
function buildV3FuncTable1A() {
  var pkt = parseHex('33 DA AD DA AD 01 0B 00 1A 00 00 00 00 00');
  pkt[10] = v3Seq & 0xFF; pkt[11] = (v3Seq >> 8) & 0xFF; v3Seq++;
  var crc = crc16Ccitt(pkt, 1, pkt.length - 3);
  pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
  return pkt;
}
function buildHrModeSample() {
  var pkt = parseHex('33 DA AD DA AD 01 17 00 09 00 00 00 00 00 00 00 00 01 00 00 17 3B 00 00 00 00');
  pkt[10] = v3Seq & 0xFF; pkt[11] = (v3Seq >> 8) & 0xFF; v3Seq++;
  var crc = crc16Ccitt(pkt, 1, pkt.length - 3);
  pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
  return pkt;
}
function handleLegacy(arr) {
  if (arr.length >= 3 && arr[0] === 0x04 && (arr[1] === 0x01 || arr[1] === 0x02 || arr[1] === 0x03 || arr[1] === 0x05)) {
    if (arr[1] === 0x01 && arr.length >= 17) {
      bindMac = arr.slice(5, 11);
      bindChallenge = arr.slice(11, 17); // watch clock, sealed with MAC into 04 05
      show('BIND reply: key=0x01 status=' + arr[2] + ' challenge=' + hexStr(bindChallenge) + ' (captured for 04 05 auth)');
    } else {
      show('BIND reply: key=0x0' + arr[1].toString(16) + ' status=' + arr[2] + ' (00 = ok; 04 05 status 0 finalizes, QR should clear)');
    }
    return;
  }
  if (arr.length >= 2 && arr[0] === 0x02 && arr[1] === 0x01) {
    var pair = arr.length > 8 ? arr[8] : -1;
    var bindFlag = arr.length > 13 ? arr[13] : -1;
    lastPair = pair; // drives the auto-sync decision after Connect
    show('INFO 02 01: pair=' + pair + ' bind_flag=' + bindFlag + ' (bound usually pair=1; fresh reset shows QR until bind)');
    return;
  }
  if (arr.length >= 2 && arr[0] === 0x03) {
    show('SET ack: 03 ' + arr[1].toString(16) + ' (00s = ok)');
    return;
  }
}
// Last item_count seen on START replies (operate 0x00) per type; STOP acks
// (operate 0x01) don't touch these. The sync loop uses item_count == 0 as its
// end-of-history stop rule.
var lastSleepItems = -1, lastSportItems = -1, lastHrItems = -1, lastWorkoutItems = -1, lastSwimItems = -1, lastSpo2Items = -1, lastPressItems = -1, lastPair = -1;
// Per-type accessors so the generic pager (pageType) can drive all 7 types
// without seven copies of the same loop.
function getItems(t) { return t === 8 ? lastSportItems : t === 3 ? lastHrItems : t === 7 ? lastSleepItems : t === 4 ? lastWorkoutItems : t === 6 ? lastSwimItems : t === 1 ? lastSpo2Items : lastPressItems; }
function setItems(t, v) { if (t === 8) lastSportItems = v; else if (t === 3) lastHrItems = v; else if (t === 7) lastSleepItems = v; else if (t === 4) lastWorkoutItems = v; else if (t === 6) lastSwimItems = v; else if (t === 1) lastSpo2Items = v; else lastPressItems = v; }
// Best-effort date from a day-data header: sport layout (year u16 @[1:3],
// month [3], day [4]) or HR layout (year u16 @[0:2], month [2], day [3]).
function guessHeaderDate(h) {
  if (!h || h.length < 5) return null;
  var y1 = u16le(h, 1), m1 = h[3], d1 = h[4];
  if (y1 >= 2020 && y1 <= 2035 && m1 >= 1 && m1 <= 12 && d1 >= 1 && d1 <= 31) return y1 + '-' + pad2(m1) + '-' + pad2(d1);
  var y2 = u16le(h, 0), m2 = h[2], d2 = h[3];
  if (y2 >= 2020 && y2 <= 2035 && m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) return y2 + '-' + pad2(m2) + '-' + pad2(d2);
  return null;
}
// Captured decoded records for the on-phone store (reset at each macro start).
// Sport/HR accumulate one entry per header date across day-offset rounds;
// capSport/capHr alias the latest (offset-0) entry for the live fallback.
var capLive = null, capSport = null, capHr = null, capSleepNights = [], capWorkouts = [];
var capSportDays = [], capHrDays = [];
// Raw SpO2 (01) / pressure (02) day records — layout not yet anchored, so
// keep the full header+data hex alongside any guessed date.
var capSpo2 = [], capPress = [];
// Whole days between two YYYY-MM-DD dates (pure, phone-safe).
function dayDiff(a, b) {
  function dayNum(ds) {
    return Date.UTC(Number(ds.slice(0, 4)), Number(ds.slice(5, 7)) - 1, Number(ds.slice(8, 10))) / 86400000;
  }
  return Math.round(dayNum(b) - dayNum(a));
}
// Last successful sync day (YYYY-MM-DD) or null when never synced.
// Stored as a meta record so any page can read it; failures read as null.
async function getLastSyncDay() {
  try {
    var r = await Store.get('last-sync', 'meta');
    if (r && r.payload && typeof r.payload.day === 'string') return r.payload.day;
  } catch (e) {}
  return null;
}
async function setLastSyncDay(day, tag) {
  try {
    await Store.put('last-sync', 'meta', {
      day: day, at: new Date().toISOString(), tag: tag || '',
    });
  } catch (e) { log('Last-sync stamp failed: ' + e); }
}
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  var n = new Date();
  return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate());
}
function resetCaptures() {
  capLive = null; capSport = null; capHr = null; capWorkouts = []; capSleepNights = [];
  capSportDays = []; capHrDays = []; capSpo2 = []; capPress = [];
}
// One entry per header date; re-fetched days overwrite in place.
function upsertDay(list, entry) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].date === entry.date) { list[i] = entry; return; }
  }
  list.push(entry);
}
function refreshStoreStatus() {
  var el = document.getElementById('storeStatus');
  if (!el || typeof Store === 'undefined') return;
  Promise.all([
    Store.list('steps'), Store.list('sleep'), Store.list('hr'), Store.list('workout'),
    Store.list('spo2'), Store.list('pressure'),
  ]).then(function (r) {
    el.textContent = 'Store: ' + r[0].length + ' step days, ' + r[1].length +
      ' nights, ' + r[2].length + ' HR days, ' + r[3].length + ' workouts, ' +
      r[4].length + ' SpO2, ' + r[5].length + ' pressure.';
  }, function (e) { el.textContent = 'Store unavailable: ' + e; });
}
// Persist captured records to the on-phone store. Sport is keyed by its
// header date (v3 type08 headers carry year/month/day — same rule as
// workouts/sleep); live 02A0 stays phone-dated as the no-header fallback.
async function saveCaptured(tag) {
  var saved = [];
  try {
    if (capSportDays.length) {
      for (var si = 0; si < capSportDays.length; si++) {
        var sd = capSportDays[si];
        await Store.put(sd.date, 'steps', {
          date: sd.date, steps: sd.steps, distance_m: sd.distanceM,
          kcal: sd.displayKcal !== null ? sd.displayKcal : '',
          active_min: sd.activeMin !== null ? sd.activeMin : '',
          source: 'v3 sport type08 diagnostics.html ' + tag,
        });
      }
      saved.push(capSportDays.length + ' step day(s)');
    } else if (capLive) {
      await Store.put(todayStr(), 'steps', {
        date: todayStr(), steps: capLive.steps, distance_m: capLive.distanceM,
        kcal: '', active_min: '',
        source: 'live 02A0 diagnostics.html ' + tag,
      });
      saved.push('steps(live)');
    }
    for (var i = 0; i < capSleepNights.length; i++) {
      var n = capSleepNights[i];
      await Store.put(n.night, 'sleep', {
        night: n.night, fall_asleep: n.fallAsleep, get_up: n.getUp,
        total_min: n.tot, wake_min: n.wake, light_min: n.light,
        rem_min: n.rem, deep_min: n.deep, source: 'v3 type07 diagnostics.html ' + tag,
      });
    }
    if (capSleepNights.length) saved.push(capSleepNights.length + ' night(s)');
    if (capHrDays.length) {
      for (var hi = 0; hi < capHrDays.length; hi++) {
        var hd = capHrDays[hi];
        await Store.put(hd.date, 'hr', {
          date: hd.date, start_time_s: hd.startS, silent_hr: hd.silent,
          zones: hd.zones, samples: hd.samples,
          source: 'v3 type03 diagnostics.html ' + tag,
        });
      }
      saved.push(capHrDays.length + ' HR day(s)');
    }
    if (capWorkouts.length) {
      for (var wi = 0; wi < capWorkouts.length; wi++) {
        var w = capWorkouts[wi];
        var wkey = w.date + ' ' + w.startS;
        await Store.put(wkey, 'workout', w);
      }
      saved.push(capWorkouts.length + ' workout(s)');
    }
    var rawTypes = [[capSpo2, 'spo2'], [capPress, 'pressure']];
    for (var rt = 0; rt < rawTypes.length; rt++) {
      var arr = rawTypes[rt][0], stype = rawTypes[rt][1];
      for (var ri = 0; ri < arr.length; ri++) {
        var rec = arr[ri];
        await Store.put(rec.date || ('raw-' + ri), stype, rec);
      }
      if (arr.length) saved.push(arr.length + ' ' + stype + ' record(s)');
    }
    log('Saved to store [' + tag + ']: ' + (saved.length ? saved.join(', ') : 'nothing captured'));
    // Incremental-sync anchor: next sync fetches forward from this day.
    // Stamped only when something landed, so failed syncs retry the gap.
    if (saved.length) await setLastSyncDay(todayStr(), tag);
if (typeof Store !== 'undefined') refreshStoreStatus();
else document.getElementById('storeStatus').textContent = 'store.js not found next to diagnostics.html — keep both files together.';
  } catch (e) { log('Store save failed [' + tag + ']: ' + e); }
}
// After Connect: read the bind flag, then sync automatically when bound.
// A fresh-reset watch (pair=0) skips the 4-minute pull and asks for A instead.
async function autoSyncAfterConnect(opts) {
  log('Auto-sync: checking bind state...');
  lastPair = -1;
  await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
  await wait(3000);
  if (lastPair === 1) {
    log('Watch bound (pair=1) — starting automatic sync.');
    await syncNow(opts);
  } else if (opts.autoSetup) {
    show('Watch not bound (pair=' + lastPair + ') — running first-time setup (bind + auth, ~90 s).');
    setProgress(1, 1, 'First-time setup (~90 s)');
    await setupAuto();
    if (lastPair === 1) {
      log('Setup complete (pair=1) — starting the first sync.');
      await syncNow(opts);
    } else {
      throw new Error('Watch still reports pair=' + lastPair + ' after setup');
    }
  } else {
    show('Watch not bound (pair=' + lastPair + ') — open Settings → Set up watch first.');
  }
}
var macroRunning = false;
function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
// Reply-driven wait: resolves the moment isDone() is true (polled every
// 250 ms), or after capMs at the latest. Caps are generous on purpose —
// worst observed reply latency is under a second, caps are 10-12 s, and a
// timeout never cuts a frame: reassembly always finishes what it started.
// Typical runs proceed in ~1 s per step; slow watches just take the cap.
function waitFor(isDone, capMs, label) {
  var waited = 0;
  return new Promise(function (resolve) {
    function poll() {
      var done = false;
      try { done = !!isDone(); } catch (e) { done = false; }
      if (done || waited >= capMs) {
        if (!done) log('Timeout waiting (' + label + ') — continuing anyway.');
        resolve();
        return;
      }
      waited += 250;
      setTimeout(poll, 250);
    }
    poll();
  });
}
function setMacroButtons(disabled) {
  ['btnSetupAuto', 'btnDailyAuto', 'btnSyncAll'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.disabled = disabled;
  });
}
async function setupAuto() {
  // Replays VeryFit's own reinstall-bind order (reinstall_app_bind_stripped):
  // func-table reads, DND read, bind, DND read, weather/goals/units, info,
  // HR-mode x2, battery, user info, time, info. ~90 s total.
  if (macroRunning) { log('A macro is already running — wait for it to finish.'); return; }
  macroRunning = true; setMacroButtons(true);
  try {
    log('[Setup 1/18] Func table...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x02]));
    await wait(2000);
    log('[Setup 2/18] Func table ex...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x07]));
    await wait(2000);
    log('[Setup 3/18] MTU...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0xF0]));
    await wait(2000);
    log('[Setup 4/18] v3 func table...');
    await wr(writeChar, '0x0AF6', buildV3FuncTable1A());
    await wait(3000);
    log('[Setup 5/18] DND state...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x30]));
    await wait(2000);
    log('[Setup 6/18] Bind (04 01, no tap needed — auth at step 8 finalizes)...');
    await wr(writeChar, '0x0AF6', buildBindStart());
    await wait(12000); // confirm window on the watch
    log('[Setup 7/18] 03 23 (VeryFit sends this between bind and auth)...');
    await wr(writeChar, '0x0AF6', buildSet23Sample());
    await wait(2000);
    log('[Setup 8/18] Auth 04 05 (challenge XOR MAC — finalizes bind)...');
    var auth = buildBindAuthPacket();
    if (auth) await wr(writeChar, '0x0AF6', auth);
    await wait(3000);
    log('[Setup 9/18] DND state again...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x30]));
    await wait(3000);
    log('[Setup 10/18] Weather switch off...');
    await wr(writeChar, '0x0AF6', buildWeatherOff());
    await wait(2000);
    log('[Setup 11/18] Goals...');
    await wr(writeChar, '0x0AF6', buildGoalsSample());
    await wait(2000);
    log('[Setup 12/18] Units...');
    await wr(writeChar, '0x0AF6', buildUnitsSample());
    await wait(2000);
    log('[Setup 13/18] Device info...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
    await wait(3000);
    log('[Setup 14/18] HR mode (x2)...');
    await wr(writeChar, '0x0AF6', buildHrModeSample());
    await wait(2000);
    await wr(writeChar, '0x0AF6', buildHrModeSample());
    await wait(3000);
    log('[Setup 15/18] Battery...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x05]));
    await wait(2000);
    log('[Setup 16/18] User info...');
    await wr(writeChar, '0x0AF6', buildUserInfoSample());
    await wait(2000);
    log('[Setup 17/18] Set time (phone clock)...');
    await wr(writeChar, '0x0AF6', buildSetTimeNow());
    await wait(2000);
    log('[Setup 18/18] Device info (check pair=1 above)...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0x01]));
    await wait(3000);
    show('Setup done — QR should be gone. Tap Sync on the dashboard.');
  } finally { macroRunning = false; setMacroButtons(false); }
}
// Generic cursor-paged pull for one COUNT-data type (04 workouts, 06 swims,
// 07 sleep). The watch advances to the next record on STOP; offset 0 is the
// oldest record. Each round sends START/STOP, waits for the reply, and stops
// on items==0 or staleLimit consecutive rounds with no new capture (freshFn
// counts captured records). onRound(r, max) drives progress display.
async function pageType(dataType, maxRounds, label, staleLimit, freshFn, onRound) {
  var stale = 0;
  for (var r = 0; r < maxRounds; r++) {
    if (onRound) onRound(r + 1, maxRounds);
    var before = freshFn ? freshFn() : 0;
    setItems(dataType, -1);
    log(label + ' round ' + (r + 1) + '/' + maxRounds + '...');
    await wr(writeChar, '0x0AF6', buildV3Start04(dataType, 0));
    await waitFor(function () { return getItems(dataType) >= 0; }, 12000, label + ' reply');
    await wr(writeChar, '0x0AF6', buildV3Stop04(dataType));
    await wait(3000);
    if (getItems(dataType) === 0) { log(label + ' history empty — paging done.'); break; }
    stale = (freshFn && freshFn() > before) ? 0 : stale + 1;
    if (stale >= staleLimit) { log(label + ' repeats known records — paging done.'); break; }
  }
}
// Today's record for a day-data type: START/STOP with byte14=1 at offset 0.
// This is the ONLY way to get the in-progress day — the historical stream
// (byte14=0) serves completed days only (oldest -> yesterday). b14=1 never
// touches the historical cursor (live 2026-11-05).
async function pullToday(dataType, label) {
  setItems(dataType, -1);
  await wr(writeChar, '0x0AF6', buildV3Start04(dataType, 0)); // byte14 default = 1
  await waitFor(function () { return getItems(dataType) >= 0; }, 12000, label + ' today reply');
  var items = getItems(dataType);
  await wr(writeChar, '0x0AF6', buildV3Stop04(dataType)); // matching byte14=1
  await wait(800);
  log(label + ' today: items=' + items);
}
// Completed-day history paging for day-data types (08 sport, 03 HR, 01 SpO2,
// 02 pressure) on 0x0AF6. LIVE 2026-11-05: the watch keeps a PERSISTENT sync
// cursor over completed days, oldest first. Each round returns the next day:
//   START oper=0 type T byte14=0 saveOffset=0
//   STOP  oper=1 type T byte14=0 saveOffset=0   <- this advances the cursor
// saveOffset is ignored on 0x0AF6, 0x05 priming does not move the cursor, and
// the cursor survives disconnect/reconnect. It is NOT rewound by b14=1, 0x05,
// or a bare STOP (all tested 2026-11-05); after items=0 it stays spent until
// the watch resets it. Decoded days land in cap*Days/capSpo2/capPress keyed by
// header date, so re-served days overwrite instead of duplicating.
async function pageDayHistory(dataType, label, maxRounds, freshFn, onRound) {
  var stale = 0;
  for (var r = 0; r < maxRounds; r++) {
    if (onRound) onRound(r + 1, maxRounds);
    var before = freshFn ? freshFn() : 0;
    setItems(dataType, -1);
    await wr(writeChar, '0x0AF6', buildV3Start04(dataType, 0, 0));
    await waitFor(function () { return getItems(dataType) >= 0; }, 12000, label + ' history reply');
    var items = getItems(dataType);
    if (items < 0) { log(label + ' history: no reply — stopping (no STOP sent).'); break; }
    await wr(writeChar, '0x0AF6', buildV3Stop04(dataType, 0)); // matching byte14=0
    await wait(1000);
    if (items === 0) { log(label + ' history: no more completed days — done.'); break; }
    var fresh = freshFn ? freshFn() : 0;
    log(label + ' history round ' + (r + 1) + ': items=' + items + ' (captured ' + fresh + ')');
    stale = (fresh > before) ? 0 : stale + 1;
    if (stale >= 2) { log(label + ' history repeats the same day — stopping.'); break; }
  }
}
// The one sync path (dashboard Sync, Diagnostics Connect auto-sync, and the
// Full sync button all use it). Pulls today (b14=1) then drains the watch's
// (b14=0) until items=0, with a 60-round safety cap. The queue is finite, so
// there is no day-window/gap logic: the last-sync stamp is logging only.
// opts.deep widens count-data paging (sleep/workouts/swims) from 8 to 30
// rounds. opts.days is accepted for old callers but no longer caps anything.
async function syncNow(opts) {
  opts = opts || {};
  if (macroRunning) { log('A macro is already running — wait for it to finish.'); return; }
  macroRunning = true; setMacroButtons(true); resetCaptures();
  var lastDay = await getLastSyncDay();
  if (lastDay) {
    log('Last sync ' + lastDay + ' (' + dayDiff(lastDay, todayStr()) + 'd ago) — draining the completed-day queue.');
  } else {
    log('No previous sync stamp — pulling today + every queued completed day.');
  }
  var historyCap = 60;
  var countRounds = opts.deep ? 30 : 8;
  try {
    log('[Sync 0/8] Sync time (phone clock)...');
    await wr(writeChar, '0x0AF6', buildSetTimeNow());
    await wait(2000);
    setProgress(1, 8, 'Live data'); log('[Sync 1/8] Live data...');
    await wr(writeChar, '0x0AF6', new Uint8Array([0x02, 0xA0]));
    await waitFor(function () { return capLive !== null; }, 8000, 'live reply');
    setProgress(2, 8, 'Sport days'); log('[Sync 2/8] Sport days (today + completed-day cursor)...');
    await pullToday(8, 'Sport');
    await pageDayHistory(8, 'Sport', historyCap, function () { return capSportDays.length; },
      function (r) { setProgress(2, 8, 'Sport day ' + r); });
    setProgress(3, 8, 'Sleep'); log('[Sync 3/8] Sleep nights (byte-paged)...');
    await pageType(7, countRounds, 'Sleep', 3, function () { return capSleepNights.length; },
      function (r) { setProgress(3, 8, 'Sleep round ' + r); });
    setProgress(4, 8, 'HR days'); log('[Sync 4/8] Heart-rate days (today + completed-day cursor)...');
    await pullToday(3, 'HR');
    await pageDayHistory(3, 'HR', historyCap, function () { return capHrDays.length; },
      function (r) { setProgress(4, 8, 'HR day ' + r); });
    setProgress(5, 8, 'Workouts'); log('[Sync 5/8] Workouts (byte-paged)...');
    await pageType(4, countRounds, 'Workout', 3, function () { return capWorkouts.length; },
      function (r) { setProgress(5, 8, 'Workout round ' + r); });
    setProgress(6, 8, 'Swims'); log('[Sync 6/8] Swims (byte-paged)...');
    await pageType(6, countRounds, 'Swim', 3, function () { return capWorkouts.length; },
      function (r) { setProgress(6, 8, 'Swim round ' + r); });
    setProgress(7, 8, 'SpO2'); log('[Sync 7/8] SpO2 days (today + completed-day cursor)...');
    await pullToday(1, 'SpO2');
    await pageDayHistory(1, 'SpO2', historyCap, function () { return capSpo2.length; },
      function (r) { setProgress(7, 8, 'SpO2 day ' + r); });
    setProgress(8, 8, 'Pressure'); log('[Sync 8/8] Pressure days (today + completed-day cursor)...');
    await pullToday(2, 'Pressure');
    await pageDayHistory(2, 'Pressure', historyCap, function () { return capPress.length; },
      function (r) { setProgress(8, 8, 'Pressure day ' + r); });
    await saveCaptured((opts.deep ? 'full ' : 'daily ') + todayStr());
    show((opts.deep ? 'Full sync done' : 'Daily sync done') +
      ' — everything saved. <a href="index.html">Open dashboard →</a> (JSONL download kept as audit trail).');
  } finally { macroRunning = false; setMacroButtons(false); }
}
// Back-compat name for the Diagnostics page's full-sync button: same path,
// wider count-data paging.
function syncAll() { return syncNow({ deep: true }); }
// v3 0x04 STOP. byte14 must MATCH the START that opened the session:
//   byte14=1 closes "today" (the b14=1 pull),
//   byte14=0 closes a historical day and ADVANCES the completed-day cursor.
// LIVE 2026-11-05 (ID208 Plus, 0x0AF6): START(b14=0)+STOP(b14=0) returned
// 2026-10-31 -> 11-01 -> 11-02 -> 11-03 -> 11-04 -> items=0, one completed day
// per round, on every day-data type (08/03/01/02). The old STOP always used
// the b14=1 default, so the historical session was never closed with the
// matching flag and the cursor never advanced — that was the history bug.
function buildV3Stop04(dataType, b14Override) {
  var pkt = buildV3Start04(dataType, 0, b14Override);
  pkt = new Uint8Array(pkt);
  pkt[12] = 0x01; // operate STOP
  var crc = crc16Ccitt(pkt, 1, pkt.length - 3);
  pkt[pkt.length - 2] = crc & 0xFF; pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
  return pkt;
}
function handleV3(arr) {
  var inAsm = rxBuf && rxWritten < rxBuf.length && rxWritten > 0;
  if (inAsm && arr[0] === 0x33 && !(arr.length >= 5 && arr[1] === 0xDA && arr[2] === 0xAD)) {
    var n = Math.min(arr.length - 1, rxBuf.length - rxWritten);
    rxBuf.set(arr.subarray(1, 1 + n), rxWritten); rxWritten += n;
  } else if (arr[0] === 0x33 && arr[1] === 0xDA && arr[2] === 0xAD && arr[3] === 0xDA && arr[4] === 0xAD && arr.length >= 10) {
    var total = v3TotalLen(arr);
    if (total <= 0 || total > 8192) return;
    rxBuf = new Uint8Array(total); rxWritten = 0;
    var m = Math.min(total, arr.length - 1);
    rxBuf.set(arr.subarray(1, 1 + m), 0); rxWritten = m;
  } else return;
  if (rxBuf && rxWritten === rxBuf.length) { dispatchV3(rxBuf); rxBuf = null; rxWritten = 0; }
}
function dispatchV3(buf) {
  // buf starts with DA AD DA AD (leading 0x33 stripped); cmd at [7..8], seq at [9..10], payload from [11].
  if (buf.length < 11) return;
  var cmd = buf[7] | (buf[8] << 8), seq = buf[9] | (buf[10] << 8);
  var p = buf.subarray(11);
  log('v3 complete: cmd=0x' + cmd.toString(16) + ' seq=0x' + seq.toString(16) + ' payloadBytes=' + p.length);
  if (cmd === 0x0005 && p.length >= 4) {
    var total = u32le(p, 0);
    show('Health sizes reply: totalBytes=' + total + ' (expect ~1021 if watch has fresh data)');
    log('0x05 reply payload ' + p.length + 'B: ' + hexStr(p));
    // Speculative per-type records after the leading u32 total: 7 x (type u8 + u32 LE).
    for (var ri = 4; ri + 5 <= p.length; ri += 5) {
      log('  0x05 rec type=0x' + p[ri].toString(16) + ' val=' + u32le(p, ri + 1));
    }
    return;
  }
  if (cmd !== 0x0004 || p.length < 14) return;
  var dataType = p[1], itemCount = u16le(p, 5), headSize = u16le(p, 7), dataSize = u32le(p, 9);
  if (p[0] === 0x00) { // START reply only; STOP acks must not reset the trackers
    if (dataType === 7) lastSleepItems = itemCount;
    else if (dataType === 8) lastSportItems = itemCount;
    else if (dataType === 3) lastHrItems = itemCount;
    else if (dataType === 4) lastWorkoutItems = itemCount;
    else if (dataType === 1) lastSpo2Items = itemCount;
    else if (dataType === 2) lastPressItems = itemCount;
    // Post-reset empty stores can answer with an unknown data_type and zero
    // items (seen: 65 B reply to sleep START). During sleep paging that still
    // means "no more nights", so stop instead of looping 8 times.
    else if (itemCount === 0) lastSleepItems = 0;
  }
  if (p[0] !== 0x00) { // STOP ack (operate 0x01): zeroed body, never data.
    log('STOP ack dataType=' + dataType + ' (ignored for capture/display)');
    return;
  }
  var hs = 14, he = Math.min(p.length, hs + headSize), de = Math.min(p.length, he + dataSize);
  var h = p.slice(hs, he), d = p.slice(he, de);
  if (dataType === 8 && itemCount === 0) {
    // Empty-history marker (zeroed header, items=0) at the end of the cursor
    // stream. Without this guard the header falls back to the phone date and
    // OVERWRITES today's real sport record with zeros.
    log('SPORT dataType=8 items=0: empty-history marker, ignored.');
  } else if (dataType === 8 && h.length >= 20) {
    var steps = u32le(h, 8), kcal = u32le(h, 12), dist = u32le(h, 16);
    // Header carries the day (bytes 1-2 year LE, [3] month, [4] day —
    // same layout as sync.py captures.py; proven 2026-10-13 in
    // health-capture.jsonl). Fall back to phone date only when absent.
    var sportDate = (h.length >= 5 && (h[1] | h[2])) ?
      (u16le(h, 1) + '-' + pad2(h[3]) + '-' + pad2(h[4])) : todayStr();
    capSport = {
      date: sportDate, steps: steps, distanceM: dist,
      rawCalories: kcal,
      displayKcal: h.length >= 28 ? (h[26] | (h[27] << 8)) : null,
      activeMin: h.length >= 24 ? u32le(h, 20) : null,
    };
    upsertDay(capSportDays, capSport);
    show('SPORT dataType=8 items=' + itemCount + ': date=' + sportDate + ' steps=' + steps + ' kcal(raw)=' + kcal + ' distance(m)=' + dist +
      '  [watch: 5736 steps / 468 kcal]');
  } else if (dataType === 7 && itemCount === 0) {
    // Empty-history marker (zeroed header, not a night): same phantom
    // family as workouts — decoding it stored "0-00-00" zero-nights.
    log('SLEEP dataType=7 items=0: empty-history marker, ignored (not a night).');
  } else if (dataType === 7 && h.length >= 16) {
    var tot = u16le(h, 14), wake = u16le(h, 16), light = u16le(h, 18), rem = u16le(h, 20), deep = u16le(h, 22);
    var fa = u16le(h, 2) + '-' + h[4] + '-' + h[5] + ' ' + h[6] + ':' + String(h[7]).padStart(2, '0');
    var gu = u16le(h, 8) + '-' + h[10] + '-' + h[11] + ' ' + h[12] + ':' + String(h[13]).padStart(2, '0');
    var nightKey = u16le(h, 2) + '-' + pad2(h[4]) + '-' + pad2(h[5]);
    capSleepNights.push({
      night: nightKey, fallAsleep: fa, getUp: gu, tot: tot,
      wake: wake, light: light, rem: rem, deep: deep,
    });
    show('SLEEP dataType=7 items=' + itemCount + ': total=' + tot + 'm wake=' + wake + 'm light=' + light + 'm REM=' + rem + 'm deep=' + deep +
      'm fallAsleep=' + fa + ' getUp=' + gu + '  [watch: 425m 23:47->06:52]');
  } else if (dataType === 3 && itemCount === 0) {
    // Empty-history marker at the end of the cursor stream (zeroed 31-byte
    // header). Without this guard it was saved as a "0-0-0" HR day.
    log('HR dataType=3 items=0: empty-history marker, ignored.');
  } else if (dataType === 3 && h.length >= 10) {
    var yr = h[0] | (h[1] << 8), mo = h[2], dy = h[3];
    var st = (h[4] | (h[5] << 8) | (h[6] << 16) | (h[7] << 24)) >>> 0;
    var silent = h[9], zs = [];
    for (var z = 0; z < 5 && 10 + 3 * z + 1 < h.length; z++) zs.push(h[10 + 3 * z]);
    var vals = [], tt = st;
    for (var i = 0; i < itemCount && 2 * i + 1 < d.length; i++) {
      tt += d[2 * i];
      var bpm = d[2 * i + 1];
      if (bpm >= 30 && bpm <= 220) vals.push(bpm);
    }
    var hh = Math.floor(st / 3600), mm = Math.floor((st % 3600) / 60);
    var mn = vals.length ? Math.min.apply(null, vals) : -1;
    var mx = vals.length ? Math.max.apply(null, vals) : -1;
    var hrPairs = [], pt = st;
    for (var j = 0; j < itemCount && 2 * j + 1 < d.length; j++) {
      pt += d[2 * j];
      var b = d[2 * j + 1];
      if (b >= 30 && b <= 220) hrPairs.push({ t: pt, bpm: b });
    }
    capHr = {
      date: yr + '-' + pad2(mo) + '-' + pad2(dy), startS: st,
      silent: silent, zones: zs.slice(), samples: hrPairs,
    };
    upsertDay(capHrDays, capHr);
    show('HR ' + yr + '-' + mo + '-' + dy + ' start=' + hh + ':' + String(mm).padStart(2, '0') +
      ' silent=' + silent + ' zones=' + zs.join('/') + ' samples=' + vals.length + '/' + itemCount +
      ' min=' + mn + ' max=' + mx + ' bpms=' + vals.join(','));
  } else if (dataType === 3) {
    show('HR dataType=3 items=' + itemCount + ' headSize=' + headSize + ' dataSize=' + dataSize +
      ' headHex=' + hexStr(h.slice(0, Math.min(h.length, 24))) + '  (parser pending — send the JSONL)');
  } else if (dataType === 4) {
    var wdur = '?', wkcal = '?', whr = '?', wdist = '';
    var wrec = null;
    if (itemCount === 0) {
      // Empty-history marker (100 zero bytes, not a workout): decoding it
      // saved one all-zeros phantom per sync day under "<date> 0".
      log('WORKOUT dataType=4 items=0: empty-history marker, ignored (not a workout).');
    } else if (h.length >= 100) {
      var durS = u32le(h, 17), kcalW = u32le(h, 21);
      wdur = Math.floor(durS / 60) + 'm' + (durS % 60) + 's';
      wkcal = kcalW + 'kcal';
      whr = 'avg' + h[29] + '/max' + h[30] + '/min' + h[31];
      wdist = ' ' + (u32le(h, 25) / 1000).toFixed(2) + 'km pace' + Math.floor(u16le(h, 40) / 60) + "'" + (u16le(h, 40) % 60) + '"/km';
      var wsamples = [];
      for (var k = 4; k < d.length; k++) {
        if (d[k] === 0x00) break;
        if (d[k] >= 30 && d[k] <= 220) wsamples.push(d[k]);
      }
      wrec = {
        // Header date, not phone date: re-pulls overwrite the same keys
        // instead of duplicating historic workouts under each sync day.
        date: u16le(h, 1) + '-' + String(h[3]).padStart(2, '0') + '-' + String(h[4]).padStart(2, '0'),
        version: h[0], startS: h[5] * 3600 + h[6] * 60 + h[7],
        sportType: h[8], durationsS: durS, kcal: kcalW, distanceM: u32le(h, 25),
        avgHr: h[29], maxHr: h[30], minHr: h[31],
        avgCadenceSpm: h[32], maxCadenceSpm: h[33],
        avgStrideCm: h[34], maxStrideCm: h[35],
        avgSpeedKmh: u16le(h, 36) / 100,
        avgPaceS: u16le(h, 40),
        samples: wsamples,
      };
    }
    if (wrec) capWorkouts.push(wrec);
    show('WORKOUT dataType=4 items=' + itemCount + ' headSize=' + headSize + ' dataSize=' + dataSize +
      ' dur=' + wdur + ' ' + wkcal + ' HR ' + whr + wdist + ' headHex=' + hexStr(h.slice(0, Math.min(h.length, 16))));
  } else if (dataType === 6) {
    // Swim records (type 06, 34-byte header + 15-byte/min data).
    // Layout anchored 2026-10-14 pool swim (see parse_swim_summary):
    // date [0:4], start hh/mm/ss [4:7], stroke [8], kcal u16 [9],
    // distance u16 [11], laps [15], duration u16 [17], swolf [19],
    // strokes u16 [21], pool m [24], pace/100m u16 [26], rate [28].
    if (itemCount === 0) {
      lastSwimItems = 0;
      log('SWIM dataType=6 items=0: empty-history marker, ignored (not a swim).');
    } else if (h.length >= 34) {
      lastSwimItems = itemCount;
      var swimDate = u16le(h, 0) + '-' + String(h[2]).padStart(2, '0') + '-' + String(h[3]).padStart(2, '0');
      var swimStartS = h[4] * 3600 + h[5] * 60 + h[6];
      var swimDur = u16le(h, 17), swimKcal = u16le(h, 9), swimDist = u16le(h, 11);
      var swimHr = [];
      for (var m = 0; m < itemCount && (m + 1) * 15 <= d.length; m++) {
        var bpm = d[m * 15];
        if (bpm >= 30 && bpm <= 220) swimHr.push(bpm);
      }
      capWorkouts.push({
        date: swimDate, kind: 'swim',
        startS: swimStartS, durationsS: swimDur, kcal: swimKcal, distanceM: swimDist,
        avgPaceS: u16le(h, 26),
        laps: h[15], strokes: u16le(h, 21), strokeRateSpm: u16le(h, 28),
        poolLengthM: h[24], swolf: h[19], mainStroke: h[8],
        samples: swimHr,
      });
      show('SWIM dataType=6 items=' + itemCount + ' date=' + swimDate +
        ' dur=' + Math.floor(swimDur / 60) + 'm' + (swimDur % 60) + 's' +
        ' ' + swimKcal + 'kcal ' + (swimDist / 1000).toFixed(2) + 'km laps=' + h[15]);
    } else {
      show('SWIM dataType=6 items=' + itemCount + ' headSize=' + headSize + ' dataSize=' + dataSize +
        ' headHex=' + hexStr(h) + ' (short header, logged only)');
    }
  } else if ((dataType === 1 || dataType === 2) && itemCount === 0) {
    // Empty-history marker (zeroed header, not a record) — same phantom
    // family as types 04/07: ignore, never store.
    log((dataType === 1 ? 'SPO2' : 'PRESSURE') + ' dataType=' + dataType + ' items=0: empty-history marker, ignored.');
  } else if (dataType === 1 || dataType === 2) {
    // SpO2 (01) / pressure-stress (02): same "7003" header as HR (year u16
    // @[0:2], month [2], day [3], startSec u32 @[4:8]); items are 2B
    // (delta sec + value). Value range: SpO2 50-100, pressure 0-100
    // (Gadgetbridge TooburV3DayMetricParser). Raw hex kept alongside.
    var isSpo2 = dataType === 1;
    var yr2 = u16le(h, 0), mo2 = h[2], dy2 = h[3];
    var st2 = h.length >= 8 ? u32le(h, 4) : 0;
    var ddate = (yr2 >= 2018 && yr2 <= 2036 && mo2 >= 1 && mo2 <= 12 && dy2 >= 1 && dy2 <= 31)
      ? yr2 + '-' + pad2(mo2) + '-' + pad2(dy2) : guessHeaderDate(h);
    var lo = isSpo2 ? 50 : 0, hi = 100;
    var pts = [], tt2 = st2;
    for (var pi = 0; pi < itemCount && 2 * pi + 1 < d.length; pi++) {
      tt2 += d[2 * pi];
      var v = d[2 * pi + 1];
      if (v >= lo && v <= hi) pts.push({ t: tt2, value: v });
    }
    var rec2 = {
      date: ddate, startS: st2, items: itemCount, headSize: headSize, dataSize: dataSize,
      samples: pts, headHex: hexStr(h), dataHex: hexStr(d),
      source: 'v3 type0' + dataType + ' pull',
    };
    upsertDay(isSpo2 ? capSpo2 : capPress, rec2);
    show((isSpo2 ? 'SPO2' : 'PRESSURE') + ' date=' + (ddate || '?') + ' start=' + st2 +
      ' items=' + itemCount + ' samples=' + pts.length + '/' + itemCount +
      ' vals=' + pts.slice(0, 12).map(function (p) { return p.value; }).join(',') +
      ' headHex=' + hexStr(h.slice(0, Math.min(h.length, 24))));
  } else {
    show('dataType=' + dataType + ' items=' + itemCount + ' headSize=' + headSize + ' dataSize=' + dataSize + ' (logged, not decoded)');
  }
}
function show(msg) {
  log(msg);
  var el = document.getElementById('decoded');
  if (!el) return;
  el.innerHTML += '<div class="ok">' + msg + '</div>';
}
// Progress hook: pages override by re-declaring setProgress AFTER including
// this file. Default just logs (diagnostics.html relies on log lines anyway).
function setProgress(done, total, label) {
  log('[progress] ' + done + '/' + total + ' ' + label);
}
// Button lists each page fills in; enableIds skips ids the page lacks.
var PAGE_BASIC_BUTTONS = [];
var PAGE_FULL_BUTTONS = [];
function enableIds(ids) {
  ids.forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.disabled = false;
  });
}
// Named notify handlers (see remove-before-add at connect time).
function onNotifyF7(e) {
  var a = new Uint8Array(e.target.value.buffer);
  record('0x0AF7', 'RX', a);
  handleV3(a); // short v3 0x04 replies arrive here (19B START/STOP live on 0x0AF6)
  handleLegacy(a); // bind 04 01 / info 02 01 / set 03 acks
  if (a.length >= 18 && a[0] === 0x02 && a[1] === 0xA0) {
    capLive = { steps: u32le(a, 2), distanceM: u32le(a, 10), ts: new Date().toISOString() };
  }
  if (a.length >= 2 && a[0] === 0x07 && a[1] === 0x40) {
    log('ACK 07 40 (mirroring back on 0x0AF6)');
    wr(writeChar, '0x0AF6', a);
  }
}
function onNotifyF2(e) {
  var a = new Uint8Array(e.target.value.buffer);
  record('0x0AF2', 'RX', a);
  handleV3(a);
  handleLegacy(a);
}
var device = null;
// Pages fill these before use (diagnostics.html sets both; index.html leaves empty).
// Full connect flow shared by both pages. Resolves when the link is up AND
// any requested auto-sync finished. opts.noAuto skips the auto-sync (used
// when the caller only needs a write, e.g. the auto-detect toggle).
function connectAndSync(opts) {
  opts = opts || {};
  if (device && device.gatt.connected && writeChar && notifyChar) {
    log('Already connected — reusing link.');
    if (opts.noAuto) return Promise.resolve();
    return autoSyncAfterConnect(opts);
  }
  log('Requesting device (tap the ID208 in the picker, then Pair)...');
  return navigator.bluetooth.requestDevice({ filters: [{ services: [0x0AF0] }] })
    .then(function (dev) {
      device = dev;
      log('Device Selected: ' + (dev.name || '?'));
      device.addEventListener('gattserverdisconnected', function () { log('GATT disconnected (watch dropped link or another app stole it)'); });
      return setupLinkWithRetry(dev, 3).then(function () {
        if (opts.noAuto) { log('Link ready (auto-sync skipped).'); return; }
        return autoSyncAfterConnect(opts);
      });
    })
    .catch(function (err) {
      log('BT error: ' + err);
      log('Fix checklist: 1) force-stop VeryFit 2) Android Settings > Bluetooth > forget ID208 if bonded 3) toggle BT off/on 4) reboot watch (hold button) 5) Chrome location permission on 6) stay within 1m 7) retry. Tell me the LAST ok-line above (e.g. 0x0AF6 ok) plus this error.');
      throw err;
    });
}
// GATT connect + service/char/notify setup, retried. The watch is a single
// master: when another host (the phone) still holds the link, the link drops
// right after connect() and service discovery fails with "GATT Server is
// disconnected" — a fresh gatt.connect() usually wins on attempt 2-3.
function setupLinkWithRetry(dev, attempts) {
  var n = 0;
  function once() {
    n++;
    if (dev.gatt.connected) log('Already connected at GATT level, reusing');
    else log('GATT connecting (attempt ' + n + '/' + attempts + ')...');
    return Promise.resolve()
      .then(function () { return dev.gatt.connected ? dev.gatt : dev.gatt.connect(); })
      .then(function (server) {
        // The link can drop between connect() and service discovery — verify it.
        return new Promise(function (res, rej) {
          setTimeout(function () { dev.gatt.connected ? res(server) : rej(new Error('GATT dropped right after connect')); }, 800);
        });
      })
      .then(function (server) { log('GATT Connected; getting service 0x0AF0...'); return server.getPrimaryService(0x0AF0); })
      .then(function (svc) {
        log('Service found; getting 0x0AF6 (write)...');
        return svc.getCharacteristic(0x0AF6).then(function (c) {
          writeChar = c; log('0x0AF6 ok');
          log('Getting 0x0AF7 (notify)...');
          return svc.getCharacteristic(0x0AF7);
        }).then(function (c) {
          notifyChar = c; log('0x0AF7 ok');
          log('Getting 0x0AF1 (health write)...');
          return svc.getCharacteristic(0x0AF1).then(function (h) { healthWriteChar = h; log('0x0AF1 ok'); return svc; },
            function (e) { log('0x0AF1 MISSING: ' + e + ' (staying on legacy 0x0AF6/0x0AF7 only)'); return svc; });
        }).then(function (s) {
          log('Getting 0x0AF2 (health notify)...');
          return s.getCharacteristic(0x0AF2).then(function (h) { healthNotifyChar = h; log('0x0AF2 ok'); },
            function (e) { log('0x0AF2 MISSING: ' + e + ' (staying on legacy only)'); });
        }).then(function () {
          try { log('props 0x0AF6: ' + JSON.stringify(writeChar.properties)); } catch (e) {}
          try { log('props 0x0AF1: ' + JSON.stringify(healthWriteChar && healthWriteChar.properties)); } catch (e) {}
        });
      })
      .then(function () {
        // Named handlers + remove-before-add: reconnecting without reloading the
        // page must not stack duplicate listeners (every RX would log twice).
        notifyChar.removeEventListener('characteristicvaluechanged', onNotifyF7);
        notifyChar.addEventListener('characteristicvaluechanged', onNotifyF7);
        if (healthNotifyChar) {
          healthNotifyChar.removeEventListener('characteristicvaluechanged', onNotifyF2);
          healthNotifyChar.addEventListener('characteristicvaluechanged', onNotifyF2);
        }
        log('Starting notify 0x0AF7...');
        return notifyChar.startNotifications().then(function () { log('Notify ON 0x0AF7'); });
      })
      .then(function () {
        enableIds(PAGE_BASIC_BUTTONS);
        if (!healthNotifyChar) { log('Health notify unavailable; legacy 0x0AF6/0x0AF7 ready (buttons 2-3 + setup macro)'); return; }
        log('Waiting 500ms before 0x0AF2 (watch dislikes back-to-back CCCD writes)...');
        return new Promise(function (res) { setTimeout(res, 500); }).then(function () {
          log('Starting notify 0x0AF2...');
          return healthNotifyChar.startNotifications().then(function () { log('Notify ON 0x0AF2'); });
        }).then(function () {
          enableIds(PAGE_FULL_BUTTONS);
          log('Ready.');
        }, function (e) {
          log('Notify FAILED 0x0AF2: ' + e);
          log('Continuing with legacy only (buttons 2-3 work). For health: Android Settings > Bluetooth > Forget ID208, reboot watch, retry Connect — 0x0AF2 notify is refused on stale bonds.');
        });
      })
      .catch(function (e) {
        log('Link setup attempt ' + n + '/' + attempts + ' failed: ' + e);
        if (n >= attempts) throw e;
        return wait(2000).then(once);
      });
  }
  return once();
}
// Promise of a usable write link (connects first if needed, without auto-sync).
function ensureLink() {
  if (device && device.gatt.connected && writeChar) {
    log('Link already up.');
    return Promise.resolve();
  }
  return connectAndSync({ noAuto: true });
}
function wr(ch, name, bytes) {
  if (!ch) { log('Not attached: ' + name + ' (connect first / health chars missing)'); return Promise.reject(new Error('no char ' + name)); }
  record(name, 'TX', bytes);
  return ch.writeValue(bytes).catch(function (e) { log('Write failed ' + name + ': ' + e); });
}