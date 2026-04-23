/**
 * SullaRuntime.ts
 *
 * Lightweight helper library injected as `window.__sulla` into every page.
 * Provides debugged, composable, observable functions the AI agent can call
 * via `exec_in_page` — reducing multi-step workflows from 15+ tool calls
 * to 2-3 exec_in_page calls.
 *
 * Design: <5KB, ES5-compatible, zero external deps, all functions run
 * in-page with no IPC round-trips. Every call logged to __sulla.__log.
 */

export function buildSullaRuntimeScript(): string {
  return `
(function() {
  if (window.__sullaRuntimeInjected) return;
  window.__sullaRuntimeInjected = true;

  var S = {};
  S.__log = [];

  // ── Internal helpers ───────────────────────────────────────

  function log(fn, args, ok, ms, extra) {
    var entry = { fn: fn, args: [], ok: ok, ms: ms };
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      entry.args.push(typeof a === 'string' ? a.substring(0, 100) : a);
    }
    if (extra) {
      for (var k in extra) entry[k] = extra[k];
    }
    S.__log.push(entry);
    return entry;
  }

  function now() { return performance.now(); }

  function isVisible(el) {
    if (!el) return false;
    // Walk up the DOM checking computed styles only — avoids getBoundingClientRect()
    // which returns 0×0 when the WebContentsView viewport has no size set, causing
    // dehydrate() to report 0 tokens on pages like Google Maps.
    var cur = el;
    while (cur && cur !== document.documentElement) {
      var s = getComputedStyle(cur);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function plainRect(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left) };
  }

  function findEl(target) {
    if (!target) return null;
    // Handle lookup
    if (typeof target === 'string' && target.charAt(0) === '@') {
      var byHandle = document.querySelector('[data-sulla-handle="' + target + '"]');
      if (byHandle) return byHandle;
    }
    // CSS selector
    if (typeof target === 'string') {
      try { return document.querySelector(target); } catch(e) { return null; }
    }
    // Already an element
    if (target && target.nodeType === 1) return target;
    return null;
  }

  function meta(el) {
    if (!el) return null;
    return {
      el: el,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().substring(0, 200),
      visible: isVisible(el),
      rect: plainRect(el),
      handle: el.getAttribute('data-sulla-handle') || null,
      attrs: {}
    };
  }

  // ── 1. DOM Queries ─────────────────────────────────────────

  S.$ = function(sel) {
    var t = now();
    var el = findEl(sel);
    var m = meta(el);
    log('$', [sel], !!el, now() - t);
    return m;
  };

  S.$$ = function(sel) {
    var t = now();
    var els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch(e) {}
    var results = els.map(meta).filter(Boolean);
    log('$$', [sel], results.length > 0, now() - t);
    return results;
  };

  S.closest = function(startSel, ancestorSel) {
    var t = now();
    var start = findEl(startSel);
    var result = start ? start.closest(ancestorSel) : null;
    log('closest', [startSel, ancestorSel], !!result, now() - t);
    return meta(result);
  };

  // ── 2. Wait Functions ──────────────────────────────────────

  S.waitFor = function(sel, timeout) {
    timeout = timeout || 10000;
    var t = now();
    return new Promise(function(resolve, reject) {
      // Already exists?
      var el = findEl(sel);
      if (el && isVisible(el)) {
        log('waitFor', [sel], true, now() - t);
        return resolve(meta(el));
      }
      var timer, observer;
      function check() {
        var el = findEl(sel);
        if (el && isVisible(el)) {
          cleanup();
          log('waitFor', [sel], true, now() - t);
          resolve(meta(el));
        }
      }
      function cleanup() {
        if (timer) clearTimeout(timer);
        if (observer) observer.disconnect();
      }
      observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(function() {
        cleanup();
        log('waitFor', [sel], false, now() - t, { error: 'timeout' });
        reject({ error: 'timeout', waited: timeout, selector: sel });
      }, timeout);
      // Also check periodically for non-mutation changes (CSS transitions)
      var poll = setInterval(function() { check(); }, 500);
      var origCleanup = cleanup;
      cleanup = function() { origCleanup(); clearInterval(poll); };
    });
  };

  S.waitForText = function(text, timeout) {
    timeout = timeout || 10000;
    var t = now();
    return new Promise(function(resolve, reject) {
      if (document.body.innerText.indexOf(text) !== -1) {
        log('waitForText', [text], true, now() - t);
        return resolve(true);
      }
      var timer, observer;
      function check() {
        if (document.body.innerText.indexOf(text) !== -1) {
          cleanup();
          log('waitForText', [text], true, now() - t);
          resolve(true);
        }
      }
      function cleanup() { if (timer) clearTimeout(timer); if (observer) observer.disconnect(); }
      observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(function() {
        cleanup();
        log('waitForText', [text], false, now() - t, { error: 'timeout' });
        reject({ error: 'timeout', waited: timeout, text: text });
      }, timeout);
    });
  };

  S.waitForGone = function(sel, timeout) {
    timeout = timeout || 10000;
    var t = now();
    return new Promise(function(resolve, reject) {
      var el = findEl(sel);
      if (!el || !isVisible(el)) {
        log('waitForGone', [sel], true, now() - t);
        return resolve(true);
      }
      var timer, observer;
      function check() {
        var el = findEl(sel);
        if (!el || !isVisible(el)) {
          cleanup();
          log('waitForGone', [sel], true, now() - t);
          resolve(true);
        }
      }
      function cleanup() { if (timer) clearTimeout(timer); if (observer) observer.disconnect(); }
      observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(function() {
        cleanup();
        log('waitForGone', [sel], false, now() - t, { error: 'timeout' });
        reject({ error: 'timeout', waited: timeout, selector: sel });
      }, timeout);
    });
  };

  S.waitForIdle = function(timeout) {
    timeout = timeout || 10000;
    var idleMs = 500;
    var t = now();
    return new Promise(function(resolve, reject) {
      var lastActivity = Date.now();
      var timer, domObs, netObs;

      function onActivity() { lastActivity = Date.now(); }
      function cleanup() {
        if (timer) clearTimeout(timer);
        if (domObs) domObs.disconnect();
        if (netObs) netObs.disconnect();
      }

      domObs = new MutationObserver(onActivity);
      domObs.observe(document.body, { childList: true, subtree: true, attributes: true });

      try {
        netObs = new PerformanceObserver(function(list) {
          if (list.getEntries().length > 0) onActivity();
        });
        netObs.observe({ entryTypes: ['resource'] });
      } catch(e) { /* PerformanceObserver not available */ }

      var check = setInterval(function() {
        if (Date.now() - lastActivity >= idleMs) {
          clearInterval(check);
          cleanup();
          log('waitForIdle', [], true, now() - t);
          resolve(true);
        }
        if (now() - t > timeout) {
          clearInterval(check);
          cleanup();
          log('waitForIdle', [], false, now() - t, { error: 'timeout' });
          reject({ error: 'timeout', waited: timeout });
        }
      }, 100);
    });
  };

  // ── 3. Interact Functions ──────────────────────────────────

  S.click = function(target) {
    var t = now();
    var el = findEl(target);
    var fallback = null;

    if (!el) {
      log('click', [target], false, now() - t, { error: 'element not found' });
      return { ok: false, reason: 'Element not found: ' + target };
    }

    // Scroll into view first
    try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e) {}

    // Try direct click
    try {
      el.click();
      log('click', [target], true, now() - t, { fallback: null });
      return { ok: true, text: (el.innerText || '').substring(0, 100) };
    } catch(e) {}

    // Fallback: coordinate-based synthetic events
    fallback = 'coords';
    try {
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      ['mousedown', 'mouseup', 'click'].forEach(function(type) {
        el.dispatchEvent(new MouseEvent(type, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window }));
      });
      log('click', [target], true, now() - t, { fallback: 'coords' });
      return { ok: true, text: (el.innerText || '').substring(0, 100), fallback: 'coords' };
    } catch(e2) {
      log('click', [target], false, now() - t, { error: e2.message, fallback: 'coords' });
      return { ok: false, reason: e2.message };
    }
  };

  S.fill = function(target, value) {
    var t = now();
    var el = findEl(target);
    if (!el) {
      log('fill', [target, value], false, now() - t, { error: 'element not found' });
      return { ok: false, reason: 'Element not found: ' + target };
    }

    try {
      el.focus();
      // Use native setter to bypass React/Vue controlled input guards
      var nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
      );
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log('fill', [target, value], true, now() - t);
      return { ok: true };
    } catch(e) {
      log('fill', [target, value], false, now() - t, { error: e.message });
      return { ok: false, reason: e.message };
    }
  };

  S.select = function(target, value) {
    var t = now();
    var el = findEl(target);
    if (!el || el.tagName !== 'SELECT') {
      log('select', [target, value], false, now() - t, { error: 'select element not found' });
      return { ok: false, reason: 'Select not found: ' + target };
    }
    // Try by value first, then by visible text
    var found = false;
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].value === value || el.options[i].text === value) {
        el.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      log('select', [target, value], false, now() - t, { error: 'option not found' });
      return { ok: false, reason: 'Option "' + value + '" not found' };
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    log('select', [target, value], true, now() - t);
    return { ok: true };
  };

  S.submit = function(formSel) {
    var t = now();
    var form = formSel ? findEl(formSel) : document.activeElement ? document.activeElement.closest('form') : null;
    if (!form || form.tagName !== 'FORM') {
      log('submit', [formSel], false, now() - t, { error: 'form not found' });
      return { ok: false, reason: 'Form not found' };
    }
    try {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
      log('submit', [formSel], true, now() - t);
      return { ok: true };
    } catch(e) {
      // Fallback: click first submit button
      var btn = form.querySelector('[type="submit"], button:not([type])');
      if (btn) { btn.click(); log('submit', [formSel], true, now() - t, { fallback: 'button-click' }); return { ok: true }; }
      log('submit', [formSel], false, now() - t, { error: e.message });
      return { ok: false, reason: e.message };
    }
  };

  S.press = function(key, target) {
    var t = now();
    var el = target ? findEl(target) : document.activeElement || document.body;
    var keyMap = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Space: 32 };
    var code = keyMap[key] || 0;
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: key, keyCode: code, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: key, keyCode: code, bubbles: true }));
      log('press', [key], true, now() - t);
      return { ok: true };
    } catch(e) {
      log('press', [key], false, now() - t, { error: e.message });
      return { ok: false, reason: e.message };
    }
  };

  S.hover = function(target) {
    var t = now();
    var el = findEl(target);
    if (!el) { log('hover', [target], false, now() - t, { error: 'not found' }); return { ok: false }; }
    try {
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      log('hover', [target], true, now() - t);
      return { ok: true };
    } catch(e) {
      log('hover', [target], false, now() - t, { error: e.message });
      return { ok: false, reason: e.message };
    }
  };

  // ── 4. Scroll ──────────────────────────────────────────────

  S.scrollTo = function(sel) {
    var t = now();
    var el = findEl(sel);
    if (!el) { log('scrollTo', [sel], false, now() - t); return { ok: false }; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    log('scrollTo', [sel], true, now() - t);
    return { ok: true };
  };

  S.scrollBy = function(px, containerSel) {
    var t = now();
    var container = containerSel ? findEl(containerSel) : window;
    if (container && container.scrollBy) {
      container.scrollBy(0, px);
    } else if (container) {
      container.scrollTop += px;
    }
    log('scrollBy', [px, containerSel], true, now() - t);
    return { ok: true };
  };

  S.scrollInfo = function(containerSel) {
    var el = containerSel ? findEl(containerSel) : document.documentElement;
    if (!el) return { top: 0, height: 0, viewportHeight: 0, pct: 0, atTop: true, atBottom: true };
    var sTop = containerSel ? el.scrollTop : window.scrollY;
    var sHeight = el.scrollHeight;
    var vHeight = containerSel ? el.clientHeight : window.innerHeight;
    var pct = sHeight <= vHeight ? 100 : Math.round(sTop / (sHeight - vHeight) * 100);
    return { top: Math.round(sTop), height: sHeight, viewportHeight: vHeight, pct: pct, atTop: sTop < 10, atBottom: sTop + vHeight >= sHeight - 10 };
  };

  // ── 5. Extract ─────────────────────────────────────────────

  S.text = function(sel) {
    var el = sel ? findEl(sel) : document.body;
    return el ? (el.innerText || '').trim() : '';
  };

  S.table = function(sel) {
    var tbl = findEl(sel);
    if (!tbl || tbl.tagName !== 'TABLE') return [];
    var headers = [];
    var ths = tbl.querySelectorAll('thead th, tr:first-child th');
    for (var i = 0; i < ths.length; i++) headers.push((ths[i].innerText || '').trim());
    if (headers.length === 0) {
      var firstTds = tbl.querySelectorAll('tr:first-child td');
      for (var j = 0; j < firstTds.length; j++) headers.push('col' + j);
    }
    var rows = [];
    var trs = tbl.querySelectorAll('tbody tr, tr');
    for (var r = (ths.length > 0 ? 1 : 0); r < trs.length; r++) {
      var tds = trs[r].querySelectorAll('td');
      var row = {};
      for (var c = 0; c < tds.length && c < headers.length; c++) {
        row[headers[c]] = (tds[c].innerText || '').trim();
      }
      if (Object.keys(row).length > 0) rows.push(row);
    }
    return rows;
  };

  S.forms = function() {
    var results = [];
    var forms = document.querySelectorAll('form');
    for (var f = 0; f < forms.length; f++) {
      var fields = [];
      var inputs = forms[f].querySelectorAll('input, textarea, select');
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp.type === 'hidden') continue;
        var label = '';
        if (inp.id) {
          var lbl = document.querySelector('label[for="' + inp.id + '"]');
          if (lbl) label = (lbl.innerText || '').trim();
        }
        if (!label) label = inp.getAttribute('placeholder') || inp.getAttribute('aria-label') || '';
        fields.push({
          name: inp.name || inp.id || '',
          type: inp.type || inp.tagName.toLowerCase(),
          value: inp.value || '',
          label: label.substring(0, 100),
          required: inp.required,
          handle: inp.getAttribute('data-sulla-handle') || null
        });
      }
      results.push({ action: forms[f].action || '', method: forms[f].method || 'get', fields: fields });
    }
    return results;
  };

  S.attrs = function(sel) {
    var el = findEl(sel);
    if (!el) return {};
    var names = Array.prototype.slice.call(arguments, 1);
    var result = {};
    for (var i = 0; i < names.length; i++) {
      result[names[i]] = el.getAttribute(names[i]);
    }
    return result;
  };

  S.rect = function(sel) {
    var el = findEl(sel);
    return el ? plainRect(el) : null;
  };

  // ── 6. Dehydrate ───────────────────────────────────────────

  S.dehydrate = function(opts) {
    opts = opts || {};
    var maxTokens = opts.maxTokens || 5000;
    var interactiveOnly = opts.interactiveOnly || false;
    var includeText = opts.includeText !== false;

    var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, SVG:1, PATH:1, BR:1 };
    var LANDMARK = { NAV:1, MAIN:1, HEADER:1, FOOTER:1, ASIDE:1, SECTION:1, ARTICLE:1 };
    var INTERACTIVE = { A:1, BUTTON:1, INPUT:1, TEXTAREA:1, SELECT:1 };
    var lines = [];
    var tokens = 0;
    var stats = { tokens: 0, interactiveCount: 0, textNodes: 0, depth: 0 };

    function walk(node, depth) {
      if (tokens >= maxTokens) return;
      if (node.nodeType === 3) {
        var txt = (node.textContent || '').trim();
        if (txt.length > 2 && includeText) {
          var line = indent(depth) + '"' + txt.substring(0, 80) + '"';
          addLine(line, depth);
          stats.textNodes++;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (SKIP[tag]) return;
      if (!isVisible(node)) return;
      if (node.getAttribute('aria-hidden') === 'true') return;

      var isInteractive = INTERACTIVE[tag] || node.getAttribute('role') === 'button' || node.getAttribute('tabindex') != null || node.getAttribute('onclick') != null;
      var isLandmark = LANDMARK[tag] || tag === 'FORM' || tag.charAt(0) === 'H' && tag.length === 2;

      if (interactiveOnly && !isInteractive && !isLandmark) {
        // Still walk children to find interactive descendants
        var kids = node.children;
        for (var i = 0; i < kids.length; i++) walk(kids[i], depth);
        return;
      }

      var handle = node.getAttribute('data-sulla-handle');
      var id = node.id ? '#' + node.id : '';
      var text = '';
      if (isInteractive || isLandmark) {
        text = (node.innerText || '').trim().substring(0, 60);
      }
      var extra = '';
      if (tag === 'INPUT') extra = ' type=' + (node.type || 'text') + (node.placeholder ? ' placeholder="' + node.placeholder.substring(0, 30) + '"' : '');
      if (tag === 'A' && node.href) extra = ' -> ' + node.getAttribute('href').substring(0, 60);

      var line = indent(depth) + tag.toLowerCase() + (handle ? ' ' + handle : '') + id + (text ? ' "' + text + '"' : '') + extra;
      if (isInteractive) { stats.interactiveCount++; line += ' {i}'; }
      addLine(line, depth);

      var kids2 = node.children;
      for (var j = 0; j < kids2.length; j++) walk(kids2[j], depth + 1);
    }

    function indent(d) { var s = ''; for (var i = 0; i < d; i++) s += '  '; return s; }
    function addLine(line, depth) {
      var est = Math.ceil(line.length / 4);
      if (tokens + est > maxTokens) { lines.push('[... truncated]'); tokens = maxTokens; return; }
      tokens += est;
      lines.push(line);
      if (depth > stats.depth) stats.depth = depth;
    }

    walk(document.body, 0);
    stats.tokens = tokens;
    return { tree: lines.join('\\n'), stats: stats };
  };

  // ── 7. Visual Debug ────────────────────────────────────────

  S.highlight = function(sel, color) {
    color = color || 'rgba(255, 0, 0, 0.3)';
    var els = [];
    try { els = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch(e) {}
    var count = 0;
    els.forEach(function(el) {
      if (!isVisible(el)) return;
      var r = el.getBoundingClientRect();
      var ov = document.createElement('div');
      ov.setAttribute('data-sulla-highlight', '1');
      ov.style.cssText = 'position:fixed;pointer-events:none;z-index:999997;border:2px solid ' + color + ';background:' + color + ';' +
        'top:' + r.top + 'px;left:' + r.left + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
      document.body.appendChild(ov);
      count++;
    });
    return count;
  };

  S.clearHighlights = function() {
    document.querySelectorAll('[data-sulla-highlight]').forEach(function(el) { el.remove(); });
  };

  // ── 8. Compose ─────────────────────────────────────────────

  S.steps = function(fns) {
    var results = [];
    var chain = Promise.resolve();
    fns.forEach(function(fn, i) {
      chain = chain.then(function() {
        return Promise.resolve(fn()).then(function(r) {
          results.push({ step: i, ok: true, result: r });
        });
      }).catch(function(e) {
        results.push({ step: i, ok: false, error: e && e.message ? e.message : String(e) });
        return Promise.reject(e); // stop chain
      });
    });
    return chain.then(function() { return results; }).catch(function() { return results; });
  };

  S.retry = function(fn, attempts, delay) {
    attempts = attempts || 3;
    delay = delay || 1000;
    var tried = 0;
    function attempt() {
      tried++;
      return Promise.resolve(fn()).catch(function(e) {
        if (tried >= attempts) return { ok: false, attempts: tried, lastError: e && e.message ? e.message : String(e) };
        return new Promise(function(r) { setTimeout(r, delay); }).then(attempt);
      });
    }
    return attempt();
  };

  window.__sulla = S;
})();
`;
}
