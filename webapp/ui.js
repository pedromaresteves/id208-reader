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
// Text ink follows the OS theme (matchMedia needs no JS theme state).
function ink() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return { text: '#b3b3b3', bright: '#e5e5e5', bar: '#60a5fa' };
    }
  } catch (e) {}
  return { text: '#666', bright: '#333', bar: '#2563eb' };
}

function barChart(id, labels, values) {
  var g = setupCanvas(id), t = ink(), max = Math.max.apply(null, values.concat([1]));
  var bw = g.w / Math.max(1, values.length);
  g.ctx.fillStyle = t.bar;
  values.forEach(function (v, i) {
    var h = (v / max) * (g.h - 20);
    g.ctx.fillRect(i * bw + 1, g.h - 14 - h, bw - 2, h);
  });
  g.ctx.fillStyle = t.text; g.ctx.font = '10px sans-serif';
  g.ctx.fillText('max ' + max, 4, 10);
  if (labels.length) g.ctx.fillText(labels[0] + ' → ' + labels[labels.length - 1], 4, g.h - 2);
}

function lineChart(id, values, lo, hi) {
  var g = setupCanvas(id), t = ink();
  if (!values.length) return;
  var mn = (lo !== undefined) ? lo : Math.min.apply(null, values);
  var mx = (hi !== undefined) ? hi : Math.max.apply(null, values);
  if (mx === mn) mx = mn + 1;
  g.ctx.strokeStyle = '#dc2626'; g.ctx.lineWidth = 1.5; g.ctx.beginPath();
  values.forEach(function (v, i) {
    var x = (i / Math.max(1, values.length - 1)) * (g.w - 8) + 4;
    var y = g.h - 14 - ((v - mn) / (mx - mn)) * (g.h - 30);
    if (i === 0) g.ctx.moveTo(x, y); else g.ctx.lineTo(x, y);
  });
  g.ctx.stroke();
  g.ctx.fillStyle = t.text; g.ctx.font = '10px sans-serif';
  g.ctx.fillText('min ' + mn + '   max ' + mx, 4, 10);
}

// Stacked bars: nights = [{ label, total, parts: [{ v, color, name }] }].
// selected: index to highlight (others dimmed); -1 or omitted = all full.
// Remembers bar geometry on the canvas for tap-to-select (see barAt).
function stackedBarChart(id, nights, selected) {
  var g = setupCanvas(id), t = ink();
  g.el._bars = [];
  if (!nights.length) return;
  var max = 0, i;
  for (i = 0; i < nights.length; i++) max = Math.max(max, nights[i].total);
  if (!max) max = 1;
  var bw = g.w / nights.length;
  for (i = 0; i < nights.length; i++) {
    var n = nights[i], y = g.h - 14, x0 = i * bw + 1, x1 = (i + 1) * bw - 1;
    var dimmed = (selected !== undefined && selected >= 0 && selected !== i);
    if (dimmed) g.ctx.globalAlpha = 0.5;
    for (var s = 0; s < n.parts.length; s++) {
      var h = (n.parts[s].v / max) * (g.h - 30);
      y -= h;
      g.ctx.fillStyle = n.parts[s].color;
      g.ctx.fillRect(x0, y, x1 - x0, h);
    }
    g.ctx.globalAlpha = 1;
    g.el._bars.push({ x0: x0, x1: x1, index: i });
    g.ctx.fillStyle = t.bright; g.ctx.font = '10px sans-serif';
    g.ctx.fillText(fmtHM(n.total), x0, y - 2);
    g.ctx.fillStyle = t.text;
    g.ctx.fillText(n.label, x0, g.h - 2);
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
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
// Workout mode names by sport type — UNMAPPED so far (type 5 seen on both
// strength and walk records, so the label isn't simply that byte). Add
// entries only from observed watch-icon → record pairs.
var SPORT_NAMES = {};
function sportName(w) {
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

// --- Month/week date helpers (YYYY-MM-DD strings, Monday-start weeks) ---
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

// Daily goals: the watch ships 8000 steps / 500 kcal (setup sample + photos).
// Editable in the settings page; pages fall back here when unset.
var DEFAULT_GOALS = { steps: 8000, kcal: 500 };
