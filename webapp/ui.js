/* id208-reader shared UI helpers — framework-free canvas charts + formatting.
 * Included by index.html and the detail pages. No dependencies.
 */

function setupCanvas(id) {
  var c = document.getElementById(id);
  var w = c.clientWidth || 600;
  c.width = w; c.height = 120;
  return { ctx: c.getContext('2d'), w: w, h: 120, el: c };
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
// Remembers bar geometry on the canvas for tap-to-select (see barAt).
function stackedBarChart(id, nights) {
  var g = setupCanvas(id), t = ink();
  g.el._bars = [];
  if (!nights.length) return;
  var max = 0, i;
  for (i = 0; i < nights.length; i++) max = Math.max(max, nights[i].total);
  if (!max) max = 1;
  var bw = g.w / nights.length;
  for (i = 0; i < nights.length; i++) {
    var n = nights[i], y = g.h - 14, x0 = i * bw + 1, x1 = (i + 1) * bw - 1;
    for (var s = 0; s < n.parts.length; s++) {
      var h = (n.parts[s].v / max) * (g.h - 30);
      y -= h;
      g.ctx.fillStyle = n.parts[s].color;
      g.ctx.fillRect(x0, y, x1 - x0, h);
    }
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
function fmtHM(min) {
  min = Number(min) || 0;
  return Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0') + 'm';
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
// Display helper: missing values render as an em dash, never "undefined".
// Zero is a real value and renders as 0.
function num(v, suffix) {
  if (v === undefined || v === null || v === '') return '—';
  return v + (suffix || '');
}
