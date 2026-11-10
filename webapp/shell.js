/* ID208 shell — DOM logging, progress, file-skew guard, nav, store status.
 *
 * Loaded first on every page. Classic script, no build step, no deps.
 */
var IDO = window.IDO || (window.IDO = {});

IDO.shell = (function () {
  'use strict';

  function log(msg) {
    try { console.log(msg); } catch (e) {}
    var logEl = document.getElementById('log');
    if (!logEl) return;
    logEl.textContent += msg + '\n';
    var events = document.getElementById('events');
    if (events) {
      var d = document.createElement('div');
      d.appendChild(document.createTextNode(msg));
      events.appendChild(d);
    }
  }

  function show(msg) {
    log(msg);
    var el = document.getElementById('decoded');
    if (!el) return;
    el.innerHTML += '<div class="ok">' + msg + '</div>';
  }

  function hexStr(arr) {
    return Array.from(arr, function (b) {
      return b.toString(16).padStart(2, '0').toUpperCase();
    }).join(' ');
  }

  function defaultProgress(done, total, label) {
    log('[progress] ' + done + '/' + total + ' ' + label);
  }

  function forceReload() {
    location.replace(location.pathname + '?v=' + Date.now());
  }

  function hasPath(path) {
    var parts = String(path).split('.');
    var cur = window[parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (cur === undefined || cur === null) return false;
      cur = cur[parts[i]];
    }
    return typeof cur !== 'undefined';
  }

  // One fail-fast skew guard. Entries are globals ('Store') or namespaced
  // paths ('IDO.transport', 'IDO.codec.buildV3Start04').
  function checkFiles(need) {
    var missing = need.filter(function (k) { return !hasPath(k); });
    if (!missing.length) return;
    var d = document.createElement('div');
    d.style.cssText = 'background:#7f1d1d;color:#fff;padding:12px;margin:8px;border-radius:8px;font-weight:bold;';
    d.textContent = 'App files out of sync (' + missing.join(', ') +
      ' missing) — force a fresh reload, or re-download all webapp files together.';
    var b = document.createElement('button');
    b.textContent = 'Force reload (fresh files)';
    b.style.cssText = 'margin-top:8px;';
    b.addEventListener('click', forceReload);
    d.appendChild(document.createElement('br'));
    d.appendChild(b);
    document.body.insertBefore(d, document.body.firstChild);
    throw new Error('halt: ' + missing.join(','));
  }

  // Five thumb-zone destinations; lower-frequency pages live under More.
  var NAV = [
    ['index.html', 'Home', '⌂'],
    ['activity.html', 'Activity', '▥'],
    ['sleep.html', 'Sleep', '◒'],
    ['health.html', 'Health', '♡'],
  ];
  var MORE = [
    ['workout.html', 'Workouts', '◷'],
    ['watch.html', 'Watch settings', '⚙'],
    ['diagnostics.html', 'Diagnostics', '⌁'],
  ];
  function renderNav() {
    var nav = document.querySelector('nav.tabs');
    if (!nav) return;
    var current = location.pathname.split('/').pop() || 'index.html';
    if (current.indexOf('.html') < 0) current = 'index.html';
    var primary = NAV.map(function (item) {
      var here = item[0] === current ? ' aria-current="page"' : '';
      return '<a href="' + item[0] + '"' + here + '><span class="tab-icon" aria-hidden="true">' +
        item[2] + '</span><span>' + item[1] + '</span></a>';
    }).join('');
    var morePage = MORE.some(function (item) { return item[0] === current; });
    var submenu = MORE.map(function (item) {
      var here = item[0] === current ? ' aria-current="page"' : '';
      return '<a href="' + item[0] + '" role="menuitem"' + here + '><span class="tab-icon" aria-hidden="true">' +
        item[2] + '</span><span>' + item[1] + '</span></a>';
    }).join('');
    nav.innerHTML = '<div class="tab-main">' + primary +
      '<div class="more-wrap"><button type="button" class="more-trigger" aria-haspopup="true" aria-controls="moreMenu" aria-expanded="false"' +
      (morePage ? ' aria-current="page"' : '') + '><span class="tab-icon" aria-hidden="true">···</span><span>More</span></button>' +
      '<div id="moreMenu" class="more-menu" role="menu" aria-label="More pages" aria-hidden="true">' + submenu + '</div></div></div>';
    var wrap = nav.querySelector('.more-wrap');
    var trigger = nav.querySelector('.more-trigger');
    function closeMenu() {
      wrap.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      nav.querySelector('.more-menu').setAttribute('aria-hidden', 'true');
    }
    trigger.addEventListener('click', function () {
      var open = !wrap.classList.contains('open');
      wrap.classList.toggle('open', open);
      trigger.setAttribute('aria-expanded', String(open));
      nav.querySelector('.more-menu').setAttribute('aria-hidden', String(!open));
    });
    document.addEventListener('click', function (event) {
      if (!wrap.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeMenu(); trigger.focus(); }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNav);
  } else {
    renderNav();
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

  function enableIds(ids) {
    ids.forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = false;
    });
  }

  function setMacroButtons(disabled) {
    ['btnSetupAuto', 'btnDailyAuto', 'btnSyncAll'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = disabled;
    });
  }

  return {
    log: log,
    show: show,
    hexStr: hexStr,
    setProgress: defaultProgress,
    forceReload: forceReload,
    hasPath: hasPath,
    checkFiles: checkFiles,
    renderNav: renderNav,
    refreshStoreStatus: refreshStoreStatus,
    enableIds: enableIds,
    setMacroButtons: setMacroButtons,
  };
})();

// Page progress hook: index.html overrides the global; everything else logs.
var setProgress = IDO.shell.setProgress;
var PAGE_BASIC_BUTTONS = [];
var PAGE_FULL_BUTTONS = [];
