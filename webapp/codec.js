/* ID208 codec — v3 packet builders + pure health-frame decoder.
 *
 * No DOM, no BLE, no IndexedDB. decodeHealth(payload) returns a typed record
 * (or an empty/unknown marker); sync.js owns capture state and Store writes.
 */
var IDO = window.IDO || (window.IDO = {});

IDO.codec = (function () {
  'use strict';

  var V3_PREAMBLE = [0x33, 0xDA, 0xAD, 0xDA, 0xAD];
  var BYTE14 = { 1: 1, 2: 1, 3: 1, 4: 0, 6: 0, 7: 0, 8: 1 };
  var v3Seq = 0x60; // start above logcat template seqs to avoid collisions
  var bindChallenge = null, bindMac = null;

  function parseHex(s) {
    var t = s.trim().split(/[\s:]+/);
    var out = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) out[i] = parseInt(t[i], 16);
    return out;
  }

  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32le(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  // CRC-16-CCITT-FALSE (poly 0x1021, init 0xFFFF), over [1..len-3], stored LE.
  function crc16Ccitt(buf, off, len) {
    var crc = 0xFFFF;
    for (var i = off; i < off + len; i++) {
      crc ^= buf[i] << 8;
      for (var k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
    return crc;
  }

  function finish(pkt) {
    var crc = crc16Ccitt(pkt, 1, pkt.length - 3);
    pkt[pkt.length - 2] = crc & 0xFF;
    pkt[pkt.length - 1] = (crc >> 8) & 0xFF;
    return pkt;
  }

  function nextSeq() {
    var s = v3Seq;
    v3Seq = (v3Seq + 1) & 0xFFFF;
    return s;
  }

  // v3 0x05 sizes query: 137 B wire. Manual diagnostics only; sync does not
  // send it. offsets maps dataType -> 32-bit byte offset (default 0).
  function buildV3Sizes05(offsets) {
    var types = [0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x08];
    var pkt = new Uint8Array(137);
    pkt[0] = 0x33; pkt[1] = 0xDA; pkt[2] = 0xAD; pkt[3] = 0xDA; pkt[4] = 0xAD;
    pkt[5] = 0x01; pkt[6] = 0x88; pkt[7] = 0x00; pkt[8] = 0x05; pkt[9] = 0x00;
    var seq = nextSeq();
    pkt[10] = seq & 0xFF; pkt[11] = (seq >> 8) & 0xFF;
    var o = 12;
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      var off = (offsets && offsets[t]) || 0;
      pkt[o++] = t;
      pkt[o++] = off & 0xFF; pkt[o++] = (off >> 8) & 0xFF;
      pkt[o++] = (off >> 16) & 0xFF; pkt[o++] = (off >> 24) & 0xFF;
    }
    return finish(pkt);
  }

  // v3 0x04 START per type: 19 B wire. byte14 = 0x01 day-data (01,02,03,08),
  // 0x00 count-data (04,06,07). saveOffset is ignored on this firmware.
  function buildV3Start04(dataType, offset, b14Override) {
    var pkt = new Uint8Array(19);
    pkt[0] = 0x33; pkt[1] = 0xDA; pkt[2] = 0xAD; pkt[3] = 0xDA; pkt[4] = 0xAD;
    pkt[5] = 0x01; pkt[6] = 0x10; pkt[7] = 0x00; pkt[8] = 0x04; pkt[9] = 0x00;
    var seq = nextSeq();
    pkt[10] = seq & 0xFF; pkt[11] = (seq >> 8) & 0xFF;
    pkt[12] = 0x00; pkt[13] = dataType;
    pkt[14] = (b14Override === undefined || b14Override === null) ? BYTE14[dataType] : b14Override;
    pkt[15] = (offset || 0) & 0xFF; pkt[16] = ((offset || 0) >> 8) & 0xFF;
    return finish(pkt);
  }

  // STOP must echo the START's byte14 (b14=0 advances the completed-day cursor).
  function buildV3Stop04(dataType, b14Override) {
    var pkt = new Uint8Array(buildV3Start04(dataType, 0, b14Override));
    pkt[12] = 0x01; // operate STOP
    return finish(pkt);
  }

  function buildBindStart() { return new Uint8Array([0x04, 0x01, 0xF1, 0x01, 0x01, 0x02, 0x02, 0x01, 0x00]); }
  function buildBindStop() { return new Uint8Array([0x04, 0x02, 0xF1, 0x01, 0x01, 0x02, 0x02, 0x01, 0x00]); }
  function buildSet23Sample() { return new Uint8Array([0x03, 0x23, 0x02, 0x00]); }

  function setBindData(mac, challenge) {
    bindMac = mac;
    bindChallenge = challenge;
  }

  // 04 05 encrypted auth: challenge + (challenge XOR watchMAC).
  function buildBindAuthPacket() {
    if (!bindChallenge || !bindMac) {
      IDO.shell.log('No 04 01 challenge captured yet — run Bind (step 6) first');
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
  function buildUnitsSample() { return parseHex('03 11 01 01 01 00 02 01 00 00 00 01 01 01 01 00 00'); }
  function buildGoalsSample() { return parseHex('03 43 F4 01 00 00 00 00 00 00 08 07 00 00 FA 00 0E 06 0C 00'); }
  function buildWeatherOff() { return new Uint8Array([0x03, 0x2D, 0x55, 0x00, 0x00, 0x00]); }

  function buildAutoActivity(flags) {
    var pkt = new Uint8Array(11);
    pkt[0] = 0x03; pkt[1] = 0x49;
    for (var i = 0; i < 9; i++) pkt[2 + i] = (flags && flags[i]) ? 0x01 : 0x00;
    return pkt;
  }

  function buildV3FuncTable1A() {
    var pkt = parseHex('33 DA AD DA AD 01 0B 00 1A 00 00 00 00 00');
    var seq = nextSeq();
    pkt[10] = seq & 0xFF; pkt[11] = (seq >> 8) & 0xFF;
    return finish(pkt);
  }

  function buildHrModeSample() {
    var pkt = parseHex('33 DA AD DA AD 01 17 00 09 00 00 00 00 00 00 00 00 01 00 00 17 3B 00 00 00 00');
    var seq = nextSeq();
    pkt[10] = seq & 0xFF; pkt[11] = (seq >> 8) & 0xFF;
    return finish(pkt);
  }

  function guessHeaderDate(h) {
    if (!h || h.length < 5) return null;
    var y1 = u16le(h, 1), m1 = h[3], d1 = h[4];
    if (y1 >= 2020 && y1 <= 2035 && m1 >= 1 && m1 <= 12 && d1 >= 1 && d1 <= 31) return y1 + '-' + pad2(m1) + '-' + pad2(d1);
    var y2 = u16le(h, 0), m2 = h[2], d2 = h[3];
    if (y2 >= 2020 && y2 <= 2035 && m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) return y2 + '-' + pad2(m2) + '-' + pad2(d2);
    return null;
  }

  // Decode one 0x04 payload. Returns a descriptor; never touches capture state.
  function decodeHealth(p) {
    if (!p || p.length < 14) return null;
    var operate = p[0];
    var dataType = p[1];
    var itemCount = u16le(p, 5);
    var headSize = u16le(p, 7);
    var dataSize = u32le(p, 9);
    var out = {
      operate: operate, dataType: dataType, itemCount: itemCount,
      headSize: headSize, dataSize: dataSize, kind: 'unknown', empty: false,
      record: null, message: '',
    };
    if (operate !== 0x00) {
      out.kind = 'stop';
      out.message = 'STOP ack dataType=' + dataType + ' (ignored for capture/display)';
      return out;
    }
    var he = Math.min(p.length, 14 + headSize);
    var de = Math.min(p.length, he + dataSize);
    var h = p.slice(14, he), d = p.slice(he, de);

    if (dataType === 8 && itemCount === 0) {
      out.kind = 'sport'; out.empty = true;
      out.message = 'SPORT dataType=8 items=0: empty-history marker, ignored.';
    } else if (dataType === 8 && h.length >= 20) {
      var steps = u32le(h, 8), kcal = u32le(h, 12), dist = u32le(h, 16);
      var sportDate = (h.length >= 5 && (h[1] | h[2])) ?
        (u16le(h, 1) + '-' + pad2(h[3]) + '-' + pad2(h[4])) : todayStr();
      out.kind = 'sport';
      out.record = {
        date: sportDate, steps: steps, distanceM: dist,
        rawCalories: kcal,
        displayKcal: h.length >= 28 ? (h[26] | (h[27] << 8)) : null,
        activeMin: h.length >= 24 ? u32le(h, 20) : null,
      };
      out.message = 'SPORT dataType=8 items=' + itemCount + ': date=' + sportDate +
        ' steps=' + steps + ' kcal(raw)=' + kcal + ' distance(m)=' + dist +
        '  [watch: 5736 steps / 468 kcal]';
    } else if (dataType === 7 && itemCount === 0) {
      out.kind = 'sleep'; out.empty = true;
      out.message = 'SLEEP dataType=7 items=0: empty-history marker, ignored (not a night).';
    } else if (dataType === 7 && h.length >= 16) {
      var tot = u16le(h, 14), wake = u16le(h, 16), light = u16le(h, 18);
      var rem = u16le(h, 20), deep = u16le(h, 22);
      var fa = u16le(h, 2) + '-' + h[4] + '-' + h[5] + ' ' + h[6] + ':' + String(h[7]).padStart(2, '0');
      var gu = u16le(h, 8) + '-' + h[10] + '-' + h[11] + ' ' + h[12] + ':' + String(h[13]).padStart(2, '0');
      var nightKey = u16le(h, 2) + '-' + pad2(h[4]) + '-' + pad2(h[5]);
      out.kind = 'sleep';
      out.record = {
        night: nightKey, fallAsleep: fa, getUp: gu, tot: tot,
        wake: wake, light: light, rem: rem, deep: deep,
      };
      out.message = 'SLEEP dataType=7 items=' + itemCount + ': total=' + tot + 'm wake=' + wake +
        'm light=' + light + 'm REM=' + rem + 'm deep=' + deep +
        'm fallAsleep=' + fa + ' getUp=' + gu + '  [watch: 425m 23:47->06:52]';
    } else if (dataType === 3 && itemCount === 0) {
      out.kind = 'hr'; out.empty = true;
      out.message = 'HR dataType=3 items=0: empty-history marker, ignored.';
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
      out.kind = 'hr';
      out.record = {
        date: yr + '-' + pad2(mo) + '-' + pad2(dy), startS: st,
        silent: silent, zones: zs.slice(), samples: hrPairs,
      };
      out.message = 'HR ' + yr + '-' + mo + '-' + dy + ' start=' + hh + ':' + String(mm).padStart(2, '0') +
        ' silent=' + silent + ' zones=' + zs.join('/') + ' samples=' + vals.length + '/' + itemCount +
        ' min=' + mn + ' max=' + mx + ' bpms=' + vals.join(',');
    } else if (dataType === 3) {
      out.kind = 'hr';
      out.message = 'HR dataType=3 items=' + itemCount + ' headSize=' + headSize + ' dataSize=' + dataSize +
        ' headHex=' + IDO.shell.hexStr(h.slice(0, Math.min(h.length, 24))) + '  (parser pending — send the JSONL)';
    } else if (dataType === 4) {
      var wdur = '?', wkcal = '?', whr = '?', wdist = '';
      out.kind = 'workout';
      if (itemCount === 0) {
        out.empty = true;
        out.message = 'WORKOUT dataType=4 items=0: empty-history marker, ignored (not a workout).';
      } else if (h.length >= 100) {
        var durS = u32le(h, 17), kcalW = u32le(h, 21);
        wdur = Math.floor(durS / 60) + 'm' + (durS % 60) + 's';
        wkcal = kcalW + 'kcal';
        whr = 'avg' + h[29] + '/max' + h[30] + '/min' + h[31];
        wdist = ' ' + (u32le(h, 25) / 1000).toFixed(2) + 'km pace' +
          Math.floor(u16le(h, 40) / 60) + "'" + (u16le(h, 40) % 60) + '"/km';
        var wsamples = [];
        for (var k = 4; k < d.length; k++) {
          if (d[k] === 0x00) break;
          if (d[k] >= 30 && d[k] <= 220) wsamples.push(d[k]);
        }
        out.kind = 'workout';
        out.record = {
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
      out.message = 'WORKOUT dataType=4 items=' + itemCount + ' headSize=' + headSize +
        ' dataSize=' + dataSize + ' dur=' + wdur + ' ' + wkcal + ' HR ' + whr + wdist +
        ' headHex=' + IDO.shell.hexStr(h.slice(0, Math.min(h.length, 16)));
    } else if (dataType === 6) {
      if (itemCount === 0) {
        out.kind = 'swim'; out.empty = true;
        out.message = 'SWIM dataType=6 items=0: empty-history marker, ignored (not a swim).';
      } else if (h.length >= 34) {
        var swimDate = u16le(h, 0) + '-' + String(h[2]).padStart(2, '0') + '-' + String(h[3]).padStart(2, '0');
        var swimStartS = h[4] * 3600 + h[5] * 60 + h[6];
        var swimDur = u16le(h, 17), swimKcal = u16le(h, 9), swimDist = u16le(h, 11);
        var swimHr = [];
        for (var m = 0; m < itemCount && (m + 1) * 15 <= d.length; m++) {
          var sbpm = d[m * 15];
          if (sbpm >= 30 && sbpm <= 220) swimHr.push(sbpm);
        }
        out.kind = 'swim';
        out.record = {
          date: swimDate, kind: 'swim',
          startS: swimStartS, durationsS: swimDur, kcal: swimKcal, distanceM: swimDist,
          avgPaceS: u16le(h, 26),
          laps: h[15], strokes: u16le(h, 21), strokeRateSpm: u16le(h, 28),
          poolLengthM: h[24], swolf: h[19], mainStroke: h[8],
          samples: swimHr,
        };
        out.message = 'SWIM dataType=6 items=' + itemCount + ' date=' + swimDate +
          ' dur=' + Math.floor(swimDur / 60) + 'm' + (swimDur % 60) + 's' +
          ' ' + swimKcal + 'kcal ' + (swimDist / 1000).toFixed(2) + 'km laps=' + h[15];
      } else {
        out.kind = 'swim';
        out.message = 'SWIM dataType=6 items=' + itemCount + ' headSize=' + headSize +
          ' dataSize=' + dataSize + ' headHex=' + IDO.shell.hexStr(h) + ' (short header, logged only)';
      }
    } else if ((dataType === 1 || dataType === 2) && itemCount === 0) {
      out.kind = dataType === 1 ? 'spo2' : 'pressure';
      out.empty = true;
      out.message = (dataType === 1 ? 'SPO2' : 'PRESSURE') + ' dataType=' + dataType +
        ' items=0: empty-history marker, ignored.';
    } else if (dataType === 1 || dataType === 2) {
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
      out.kind = isSpo2 ? 'spo2' : 'pressure';
      out.record = {
        date: ddate, startS: st2, items: itemCount, headSize: headSize, dataSize: dataSize,
        samples: pts, headHex: IDO.shell.hexStr(h), dataHex: IDO.shell.hexStr(d),
        source: 'v3 type0' + dataType + ' pull',
      };
      out.message = (isSpo2 ? 'SPO2' : 'PRESSURE') + ' date=' + (ddate || '?') + ' start=' + st2 +
        ' items=' + itemCount + ' samples=' + pts.length + '/' + itemCount +
        ' vals=' + pts.slice(0, 12).map(function (pt) { return pt.value; }).join(',') +
        ' headHex=' + IDO.shell.hexStr(h.slice(0, Math.min(h.length, 24)));
    } else {
      out.kind = 'unknown';
      out.message = 'dataType=' + dataType + ' items=' + itemCount + ' headSize=' + headSize +
        ' dataSize=' + dataSize + ' (logged, not decoded)';
    }
    return out;
  }

  return {
    setSeq: function (s) { v3Seq = s; },
    getSeq: function () { return v3Seq; },
    setBindData: setBindData,
    parseHex: parseHex,
    u16le: u16le,
    u32le: u32le,
    crc16Ccitt: crc16Ccitt,
    buildV3Sizes05: buildV3Sizes05,
    buildV3Start04: buildV3Start04,
    buildV3Stop04: buildV3Stop04,
    buildV3FuncTable1A: buildV3FuncTable1A,
    buildHrModeSample: buildHrModeSample,
    buildBindStart: buildBindStart,
    buildBindStop: buildBindStop,
    buildSet23Sample: buildSet23Sample,
    buildBindAuthPacket: buildBindAuthPacket,
    buildSetTimeNow: buildSetTimeNow,
    buildUserInfoSample: buildUserInfoSample,
    buildUnitsSample: buildUnitsSample,
    buildGoalsSample: buildGoalsSample,
    buildWeatherOff: buildWeatherOff,
    buildAutoActivity: buildAutoActivity,
    guessHeaderDate: guessHeaderDate,
    decodeHealth: decodeHealth,
  };
})();
