/* id208-reader shared UI helpers — framework-free canvas charts + formatting.
 * Included by index.html and the detail pages. No dependencies.
 */

function setupCanvas(id) {
  var c = document.getElementById(id);
  var w = c.clientWidth || 600;
  var h = c.clientHeight || 120;
  // Backing store scaled for devicePixelRatio: all drawing below stays in
  // CSS pixels, but text and edges render crisp instead of janky.
  var dpr = (window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  var ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, w: w, h: h, el: c };
}
// Chart ink follows the active CSS theme when available, with a safe canvas
// test fallback. The drawing API remains in CSS pixels.
function uiColor(name, fallback) {
  try {
    var value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (value) return value;
  } catch (e) {}
  return fallback;
}
function ink() {
  try {
    return {
      text: uiColor('--text-muted', '#526174'),
      bright: uiColor('--text', '#182230'),
      grid: uiColor('--border-subtle', '#e8ecf2'),
      bar: uiColor('--accent', '#245bd8'),
      line: uiColor('--hr', '#c0264f'),
    };
  } catch (e) {}
  return { text: '#526174', bright: '#182230', grid: '#e8ecf2', bar: '#245bd8', line: '#c0264f' };
}

function chartText(ctx, text, x, y, align, color) {
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.fillText(String(text), x, y);
  ctx.textAlign = 'left';
}

function chartAxes(g, t, min, max, opts) {
  var ctx = g.ctx, left = opts.left || 38, right = opts.right || 8;
  var top = opts.top || 12, bottom = opts.bottom || 25;
  var plotW = Math.max(1, g.w - left - right), plotH = Math.max(1, g.h - top - bottom);
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (var i = 0; i <= 2; i++) {
    var y = top + plotH * i / 2;
    var value = max - (max - min) * i / 2;
    ctx.strokeStyle = t.grid;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(g.w - right, y); ctx.stroke();
    chartText(ctx, opts.yFormat ? opts.yFormat(value) : Math.round(value), left - 6, y + 3, 'right', t.text);
  }
  return { left: left, right: right, top: top, bottom: bottom, width: plotW, height: plotH };
}

function barChart(id, labels, values, options) {
  var opts = options || {}, g = setupCanvas(id), t = ink();
  var nums = values.map(function (v) { return Number(v) || 0; });
  var max = Math.max.apply(null, nums.concat([1]));
  if (opts.max !== undefined && Number(opts.max) > max) max = Number(opts.max);
  if (opts.goal !== undefined && Number(opts.goal) > max) max = Number(opts.goal);
  var a = chartAxes(g, t, 0, max, opts), bw = a.width / Math.max(1, nums.length);
  g.el._bars = [];
  if (opts.goal !== undefined && Number(opts.goal) >= 0) {
    var gy = a.top + a.height - (Number(opts.goal) / max) * a.height;
    g.ctx.save(); g.ctx.strokeStyle = t.text; g.ctx.lineWidth = 1;
    g.ctx.setLineDash([4, 3]); g.ctx.beginPath();
    g.ctx.moveTo(a.left, gy); g.ctx.lineTo(g.w - a.right, gy); g.ctx.stroke();
    g.ctx.restore();
  }
  nums.forEach(function (v, i) {
    var x = a.left + i * bw, h = (v / max) * a.height;
    g.ctx.fillStyle = t.bar;
    if (h > 0) g.ctx.fillRect(x + Math.max(1, bw * .12), a.top + a.height - h,
      Math.max(1, bw * .76), h);
    g.el._bars.push({ x0: x, x1: x + bw, index: i });
  });
  g.ctx.font = '10px system-ui, sans-serif';
  var stride = opts.labelEvery || (labels.length > 14 ? 5 : 1);
  labels.forEach(function (label, i) {
    if (!label || (i % stride !== 0 && i !== labels.length - 1)) return;
    chartText(g.ctx, label, a.left + (i + .5) * bw, g.h - 5, 'center', t.text);
  });
  if (opts.goal !== undefined && opts.goalLabel !== false) {
    chartText(g.ctx, opts.goalLabel || 'Goal ' + opts.goal, g.w - a.right, a.top + 10, 'right', t.text);
  }
}

function lineChart(id, values, lo, hi, options) {
  var opts = options || {}, g = setupCanvas(id), t = ink();
  var nums = values.map(function (v) { return v === null || v === '' || v === undefined ? null : Number(v); });
  var valid = nums.filter(function (v) { return typeof v === 'number' && isFinite(v); });
  if (!valid.length) { g.el._points = []; return; }
  var mn = (lo !== undefined && lo !== null) ? Number(lo) : Math.min.apply(null, valid);
  var mx = (hi !== undefined && hi !== null) ? Number(hi) : Math.max.apply(null, valid);
  if (mx === mn) { mx += 1; mn = Math.max(0, mn - 1); }
  var a = chartAxes(g, t, mn, mx, opts), times = opts.times || [];
  var timeMin = opts.timeRange ? Number(opts.timeRange[0]) : (times.length ? Math.min.apply(null, times) : 0);
  var timeMax = opts.timeRange ? Number(opts.timeRange[1]) : (times.length ? Math.max.apply(null, times) : 1);
  if (timeMax === timeMin) timeMax = timeMin + 1;
  function pointX(i) {
    if (times.length && times[i] !== undefined) {
      return a.left + ((times[i] - timeMin) / (timeMax - timeMin)) * a.width;
    }
    return a.left + (i / Math.max(1, nums.length - 1)) * a.width;
  }
  function pointY(v) { return a.top + a.height - ((v - mn) / (mx - mn)) * a.height; }
  g.el._points = [];
  var lineColor = opts.color || t.line;
  g.ctx.strokeStyle = lineColor; g.ctx.lineWidth = 2; g.ctx.lineJoin = 'round'; g.ctx.lineCap = 'round';
  var segments = [], segment = [];
  function finishSegment() {
    if (!segment.length) return;
    if (segment.length > 1) {
      g.ctx.beginPath(); g.ctx.moveTo(segment[0].x, segment[0].y);
      for (var p = 1; p < segment.length; p++) g.ctx.lineTo(segment[p].x, segment[p].y);
      g.ctx.stroke();
    }
    segments.push(segment);
    segment = [];
  }
  nums.forEach(function (v, i) {
    if (v === null || !isFinite(v)) {
      finishSegment();
      return;
    }
    var x = pointX(i), y = pointY(v);
    segment.push({ x: x, y: y, value: v, index: i });
    g.el._points.push({ x: x, y: y, value: v, index: i });
  });
  finishSegment();
  if (opts.fill && g.el._points.length > 1) {
    g.ctx.save(); g.ctx.globalAlpha = .1; g.ctx.fillStyle = lineColor;
    segments.forEach(function (points) {
      if (points.length < 2) return;
      g.ctx.beginPath(); g.ctx.moveTo(points[0].x, a.top + a.height);
      points.forEach(function (p) { g.ctx.lineTo(p.x, p.y); });
      g.ctx.lineTo(points[points.length - 1].x, a.top + a.height); g.ctx.closePath(); g.ctx.fill();
    });
    g.ctx.restore();
  }
  g.ctx.fillStyle = lineColor;
  segments.forEach(function (points) {
    if (points.length === 1 || valid.length <= 12 || opts.dots) points.forEach(function (p) {
      g.ctx.beginPath(); g.ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); g.ctx.fill();
    });
  });
  g.ctx.font = '10px system-ui, sans-serif';
  if (times.length) {
    var start = timeMin, end = timeMax, span = end - start;
    [0, .25, .5, .75, 1].forEach(function (fraction) {
      var value = Math.round(start + span * fraction);
      var label = opts.timeLabels && opts.timeLabels[fraction * 4] || fmtMinutes(value);
      chartText(g.ctx, label, a.left + a.width * fraction, g.h - 5,
        fraction === 0 ? 'left' : fraction === 1 ? 'right' : 'center', t.text);
    });
  } else if (opts.xLabels && opts.xLabels.length) {
    var labels = opts.xLabels;
    labels.forEach(function (label, i) {
      if (!label) return;
      var x = a.left + (i / Math.max(1, labels.length - 1)) * a.width;
      chartText(g.ctx, label, x, g.h - 5, i === 0 ? 'left' : i === labels.length - 1 ? 'right' : 'center', t.text);
    });
  } else if (opts.elapsed) {
    var duration = Number(opts.duration) || (nums.length > 1 ? nums.length * 5 : 0);
    [0, .5, 1].forEach(function (f) {
      var seconds = Math.round(duration * f);
      chartText(g.ctx, Math.floor(seconds / 60) + 'm', a.left + a.width * f, g.h - 5,
        f === 0 ? 'left' : f === 1 ? 'right' : 'center', t.text);
    });
  }
}

// Stacked bars: nights = [{ label, total, parts: [{ v, color, name }] }].
// selected: index to highlight (others dimmed); -1 or omitted = all full.
// Remembers bar geometry on the canvas for tap-to-select (see barAt).
function stackedBarChart(id, nights, selected) {
  var g = setupCanvas(id), t = ink();
  g.el._bars = [];
  if (!nights.length) return;
  var max = 0, i, left = 34, top = 18, bottom = 25, right = 5;
  for (i = 0; i < nights.length; i++) max = Math.max(max, nights[i].total);
  if (!max) max = 1;
  var scale = Math.max(max, 720), plotH = g.h - top - bottom, plotW = g.w - left - right;
  g.ctx.font = '10px system-ui, sans-serif';
  [0, .5, 1].forEach(function (f) {
    var y = top + plotH * f;
    g.ctx.strokeStyle = t.grid; g.ctx.lineWidth = 1;
    g.ctx.beginPath(); g.ctx.moveTo(left, y); g.ctx.lineTo(g.w - right, y); g.ctx.stroke();
    chartText(g.ctx, Math.round(scale * (1 - f) / 60) + 'h', left - 5, y + 3, 'right', t.text);
  });
  var bw = plotW / nights.length;
  for (i = 0; i < nights.length; i++) {
    var n = nights[i], y = g.h - bottom, x0 = left + i * bw + 1, x1 = left + (i + 1) * bw - 1;
    var dimmed = (selected !== undefined && selected >= 0 && selected !== i);
    if (dimmed) g.ctx.globalAlpha = 0.5;
    for (var s = 0; s < n.parts.length; s++) {
      var h = (n.parts[s].v / scale) * plotH;
      y -= h;
      g.ctx.fillStyle = n.parts[s].color;
      g.ctx.fillRect(x0, y, x1 - x0, h);
    }
    g.ctx.globalAlpha = 1;
    g.el._bars.push({ x0: x0, x1: x1, index: i });
    g.ctx.fillStyle = t.bright; g.ctx.font = '10px system-ui, sans-serif';
    // totalText lets a page hide labels for empty days or mark partial nights.
    chartText(g.ctx, n.totalText !== undefined ? n.totalText : fmtHM(n.total), (x0 + x1) / 2, y - 2, 'center', t.bright);
    g.ctx.fillStyle = t.text;
    chartText(g.ctx, n.label, (x0 + x1) / 2, g.h - 5, 'center', t.text);
  }
}

// Night index under an x coordinate (clientX - canvas left edge), or -1.
function barAt(id, x) {
  var c = document.getElementById(id);
  var bars = c._bars || [];
  for (var i = 0; i < bars.length; i++) {
    if (x >= bars[i].x0 && x <= bars[i].x1) return bars[i].index;
  }
  return -1;
}

function fmtDur(s) { return Math.floor(s / 60) + 'm' + (s % 60) + 's'; }
// Minutes -> "7h05m" for sleep totals.
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtHM(min) {
  min = Number(min) || 0;
  return Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') + 'm';
}
// Minutes since midnight -> "23:30" (types 01/02 store minutes, not seconds).
function fmtMinutes(min) {
  if (min === undefined || min === null || min === '') return '—';
  var m = Math.round(Number(min));
  return pad2(Math.floor(m / 60) % 24) + ':' + pad2(m % 60);
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function emptyStateHTML(title, hint) {
  return '<div class="empty-state"><strong>' + esc(title) + '</strong>' +
    (hint ? '<span class="muted">' + esc(hint) + '</span>' : '') + '</div>';
}
function goalRingSVG(value, goal, options) {
  var opts = options || {}, v = Math.max(0, Number(value) || 0), g = Math.max(0, Number(goal) || 0);
  var pct = g ? Math.min(1, v / g) : 0, r = 40, circumference = 2 * Math.PI * r;
  var progress = circumference * pct, shown = opts.center || (g ? Math.round(pct * 100) + '%' : '—');
  var label = opts.label || 'Daily step goal';
  return '<svg class="goal-ring" viewBox="0 0 100 100" role="img" aria-label="' +
    esc(label + ': ' + shown) + '"><circle class="ring-track" cx="50" cy="50" r="' + r +
    '" fill="none" stroke-width="8"></circle><circle class="ring-progress" cx="50" cy="50" r="' + r +
    '" fill="none" stroke-width="8" stroke-linecap="round" transform="rotate(-90 50 50)" stroke-dasharray="' +
    progress.toFixed(2) + ' ' + circumference.toFixed(2) + '"></circle><text x="50" y="54" text-anchor="middle" font-size="18" font-weight="750" fill="currentColor">' +
    esc(shown) + '</text><text x="50" y="68" text-anchor="middle" font-size="8" fill="currentColor">of goal</text></svg>';
}
// Workout mode names by sport type — UNMAPPED so far (type 5 seen on both
// strength and walk records, so the label isn't simply that byte). Add
// entries only from observed watch-icon → record pairs.
var SPORT_NAMES = {};
function sportName(w) {
  if (w && w.kind === 'swim') return 'Pool Swim';
  if (w && SPORT_NAMES[w.sportType] !== undefined) return SPORT_NAMES[w.sportType];
  return 'Workout';
}
// Display helper: missing values render as an em dash, never "undefined".
// Zero is a real value and renders as 0.
function num(v, suffix) {
  if (v === undefined || v === null || v === '') return '—';
  return v + (suffix || '');
}
// Meters (or null/missing) -> "7.64km" / "0.00km" / "—". Never conflate 0 with missing.
function kmOrDash(m) {
  if (m === undefined || m === null || m === '') return '—';
  return (Number(m) / 1000).toFixed(2) + 'km';
}

// Daily HR summary from type03 samples ([{t,bpm}] or plain numbers).
// Returns null when no valid samples; silent is kept separate (resting,
// not an average input). Pure, phone-safe.
function hrStats(d) {
  var samples = (d && d.samples) || [];
  var vals = [];
  for (var i = 0; i < samples.length; i++) {
    var b = (samples[i] && typeof samples[i] === 'object') ? samples[i].bpm : samples[i];
    if (typeof b === 'number' && b >= 30 && b <= 220) vals.push(b);
  }
  if (!vals.length) return null;
  var sum = 0, mn = vals[0], mx = vals[0], j;
  for (j = 0; j < vals.length; j++) { sum += vals[j]; if (vals[j] < mn) mn = vals[j]; if (vals[j] > mx) mx = vals[j]; }
  return { avg: Math.round(sum / vals.length), min: mn, max: mx, count: vals.length,
    silent: (d && d.silent_hr !== undefined) ? d.silent_hr : (d && d.silent !== undefined ? d.silent : null) };
}
// One narrow column for the Activity table: "68 (43–120)".
function hrCell(d) {
  var s = hrStats(d);
  if (!s) return '—';
  return s.avg + ' (' + s.min + '–' + s.max + ')';
}
// --- Shared date helpers (YYYY-MM-DD strings, local phone day) ---
function todayStr() {
  var n = new Date();
  return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate());
}
function dayDiff(a, b) {
  function dayNum(ds) {
    return Date.UTC(Number(ds.slice(0, 4)), Number(ds.slice(5, 7)) - 1, Number(ds.slice(8, 10))) / 86400000;
  }
  return Math.round(dayNum(b) - dayNum(a));
}
function monthKey(ds) { return String(ds).slice(0, 7); }
function isoDay(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function addMonths(key, n) {
  var y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1 + n;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return isoDay(y, m + 1, 1).slice(0, 7);
}
function daysInMonth(key) {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
}
// Noon-anchored parse: midnight parsing shifts days in far timezones.
function parseDay(ds) {
  return new Date(Number(ds.slice(0, 4)), Number(ds.slice(5, 7)) - 1, Number(ds.slice(8, 10)), 12);
}
function isoOf(d) { return isoDay(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
function addDays(ds, n) {
  var d = parseDay(ds);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
function mondayOf(ds) {
  var d = parseDay(ds);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoOf(d);
}
// Full Monday–Sunday weeks intersecting a month (edge weeks spill over).
function weeksOf(key) {
  var first = key + '-01', n = daysInMonth(key);
  var last = key + '-' + String(n).padStart(2, '0');
  var out = [], cur = mondayOf(first);
  while (cur <= last) {
    out.push({ start: cur, end: addDays(cur, 6) });
    cur = addDays(cur, 7);
  }
  return out;
}
// ISO week number for a YYYY-MM-DD date (weeks already run Monday–Sunday).
function isoWeek(ds) {
  var d = parseDay(ds);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3); // Thursday of this week
  var jan4 = new Date(d.getFullYear(), 0, 4);
  jan4.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + 3); // Thursday of week 1
  return 1 + Math.round((d - jan4) / 604800000);
}
// Month pager wiring shared by the detail pages: ‹/› shift CUR by n months.
function wireMonthNav(onMove) {
  document.getElementById('btnPrevM').addEventListener('click', function () { onMove(-1); });
  document.getElementById('btnNextM').addEventListener('click', function () { onMove(1); });
}

// --- Sleep quality from stage shares of actual sleep (light+deep+rem) ---
// Baselines: light 50-60%, deep 10-25%, REM 20-25%. In-range scores 100,
// otherwise -5 per percentage point outside (floor 0).
// Weights: deep 40 / REM 35 / light 25. Null when there is no sleep.
function stageScore(pct, lo, hi) {
  if (pct >= lo && pct <= hi) return 100;
  var outside = pct < lo ? lo - pct : pct - hi;
  return Math.max(0, 100 - 5 * outside);
}
function sleepScore(n) {
  var light = Number(n.light_min) || 0, deep = Number(n.deep_min) || 0, rem = Number(n.rem_min) || 0;
  var base = light + deep + rem;
  if (base <= 0) return null;
  var score = Math.round(0.25 * stageScore(100 * light / base, 50, 60) +
    0.40 * stageScore(100 * deep / base, 10, 25) +
    0.35 * stageScore(100 * rem / base, 20, 25));
  return {
    score: score,
    label: score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 55 ? 'Fair' : 'Poor',
    lightPct: Math.round(100 * light / base),
    deepPct: Math.round(100 * deep / base),
    remPct: Math.round(100 * rem / base),
  };
}

// Sleep record timestamps are "YYYY-M-D H:MM" in watch-local time.
// Date.parse is not portable for that shape, so build a local Date by hand.
function parseNightDateTime(s) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]));
}
// Best-effort "still recording" flag: the watch exposes no such field.
// A night counts as in progress when it has no totals yet, or when the
// recorded get-up time is still in the future.
function nightInProgress(n, now) {
  if (!n) return false;
  if ((Number(n.total_min) || 0) === 0) return true;
  var gu = parseNightDateTime(n.get_up);
  return !!(gu && gu.getTime() > (now || new Date()).getTime());
}

// Daily goals: the watch ships 8000 steps / 500 kcal (setup sample + photos).
// Editable in the settings page; pages fall back here when unset.
var DEFAULT_GOALS = { steps: 8000, kcal: 500 };

// --- Store backup / restore (used by Dashboard and Settings) ---
// Resolves once the browser starts the download. Callers show their own status.
function downloadStoreBackup(filename) {
  return Store.exportJSON().then(function (text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'id208-store-backup.json';
    a.click();
    return text;
  });
}

// Read a user-picked backup / steps.csv / combined JSON and write it.
// Resolves with the per-type counts from Store.importText.
function importStoreFile(file) {
  return new Promise(function (resolve, reject) {
    var rd = new FileReader();
    rd.onload = function () {
      Store.importText(String(rd.result)).then(resolve, reject);
    };
    rd.onerror = function () { reject(rd.error || new Error('read failed')); };
    rd.readAsText(file);
  });
}
