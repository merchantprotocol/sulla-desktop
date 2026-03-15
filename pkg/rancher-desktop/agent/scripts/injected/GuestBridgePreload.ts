/**
 * GuestBridgePreload.ts
 *
 * Builds the JavaScript string that is injected into every website guest
 * (webview / iframe).  The script exposes `window.sullaBridge` with methods
 * the host can call via `executeJavaScript` or `postMessage`.
 *
 * This is intentionally asset-agnostic — it works on n8n, any SPA, or a
 * plain static page.
 */

const BRIDGE_CHANNEL = 'sulla:guest:bridge';
const GLOBAL_NAME = 'sullaBridge';

/**
 * Returns a self-contained IIFE string ready to be passed to
 * `webview.executeJavaScript(script)` or injected via a <script> tag.
 */
export function buildGuestBridgeScript(): string {
  return `
(function () {
  if (window.__sullaBridgeInjected) return;
  window.__sullaBridgeInjected = true;

  var CHANNEL = ${ JSON.stringify(BRIDGE_CHANNEL) };
  var GLOBAL  = ${ JSON.stringify(GLOBAL_NAME) };

  /* ------------------------------------------------------------------ */
  /*  Host communication helper                                         */
  /* ------------------------------------------------------------------ */
  function emitToHost(type, data) {
    var payload = { type: type, data: data };

    // Electron webview ipcRenderer path
    try {
      if (window.electron && window.electron.ipcRenderer && window.electron.ipcRenderer.sendToHost) {
        window.electron.ipcRenderer.sendToHost(CHANNEL, payload);
      } else if (window.ipcRenderer && window.ipcRenderer.sendToHost) {
        window.ipcRenderer.sendToHost(CHANNEL, payload);
      }
    } catch (_) {}

    // postMessage fallback (works for iframes)
    try { window.parent.postMessage(payload, '*'); } catch (_) {}
  }

  /* ------------------------------------------------------------------ */
  /*  DOM helpers                                                       */
  /* ------------------------------------------------------------------ */
  function isVisible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.offsetParent !== null) return true;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function handleize(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function stampHandle(el, handle) {
    el.setAttribute('data-sulla-handle', handle);
  }

  function findByHandle(handle) {
    return document.querySelector('[data-sulla-handle="' + handle + '"]');
  }

  /* ------------------------------------------------------------------ */
  /*  Public bridge API — window.sullaBridge                            */
  /* ------------------------------------------------------------------ */
  var bridge = {};

  /**
   * getActionableMarkdown()
   * Returns a Markdown snapshot of the current page: title, route,
   * visible buttons, and form fields — everything the model needs to
   * decide what to do next.
   */
  bridge.getActionableMarkdown = function () {
    var lines = [];
    var usedHandles = {};

    function uniqueHandle(base) {
      if (!usedHandles[base]) { usedHandles[base] = 1; return base; }
      usedHandles[base]++;
      return base + '-' + usedHandles[base];
    }

    lines.push('# Page — ' + document.title);
    lines.push('**URL**: ' + location.href);
    lines.push('**Route**: ' + location.pathname + location.hash);
    lines.push('**Time**: ' + new Date().toISOString());
    lines.push('');

    // Buttons
    lines.push('## Buttons');
    var buttons = document.querySelectorAll('button, [role="button"], [data-test-id]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (!isVisible(btn)) continue;
      var text = (btn.textContent || '').trim().slice(0, 60);
      if (!text) continue;
      var handle = uniqueHandle('@btn-' + handleize(text));
      stampHandle(btn, handle);
      var state = btn.disabled ? 'disabled' : 'enabled';
      lines.push('- **' + handle + '** "' + text + '" (' + state + ')');
    }

    // Links
    lines.push('');
    lines.push('## Links');
    var links = document.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      var link = links[j];
      if (!isVisible(link)) continue;
      var linkText = (link.textContent || '').trim().slice(0, 60);
      if (!linkText) continue;
      var href = link.getAttribute('href') || '';
      var linkHandle = uniqueHandle('@link-' + handleize(linkText));
      stampHandle(link, linkHandle);
      lines.push('- **' + linkHandle + '** "' + linkText + '" → ' + href);
    }

    // Form fields
    lines.push('');
    lines.push('## Form Fields');
    var fields = document.querySelectorAll('input, textarea, select');
    for (var k = 0; k < fields.length; k++) {
      var el = fields[k];
      if (!isVisible(el)) continue;
      var label = '';
      if (el.labels && el.labels.length > 0) {
        label = (el.labels[0].textContent || '').trim();
      }
      label = label || el.placeholder || el.name || el.id || 'Field';
      var fieldHandle = uniqueHandle('@field-' + (el.id || el.name || 'idx-' + k));
      stampHandle(el, fieldHandle);
      lines.push('- **' + fieldHandle + '** (' + (el.type || el.tagName.toLowerCase()) + ') = "' + (el.value || '') + '"' + (label ? ' label="' + label + '"' : ''));
    }

    console.log('[SULLA_GUEST] getActionableMarkdown: stamped handles', Object.keys(usedHandles));
    return lines.join('\\n');
  };

  /**
   * click(handle)
   * Clicks a button or link matching the given handle.
   * Handles: @btn-<slug>, @link-<slug>, or a CSS selector / data-test-id.
   */
  bridge.click = function (handle) {
    console.log('[SULLA_GUEST] click called', { handle: handle });
    if (!handle) { console.log('[SULLA_GUEST] click: handle is empty, returning false'); return false; }

    // Primary: resolve via stamped data-sulla-handle attribute
    var stamped = findByHandle(handle);
    console.log('[SULLA_GUEST] click: findByHandle result', { found: !!stamped, selector: '[data-sulla-handle=\"' + handle + '\"]' });
    if (stamped) { console.log('[SULLA_GUEST] click: clicking stamped element', { tag: stamped.tagName, id: stamped.id, text: (stamped.textContent || '').slice(0, 60) }); stamped.click(); return true; }

    // Debug: dump all stamped handles on the page
    var allStamped = document.querySelectorAll('[data-sulla-handle]');
    var stampedHandles = [];
    for (var s = 0; s < allStamped.length; s++) { stampedHandles.push(allStamped[s].getAttribute('data-sulla-handle')); }
    console.log('[SULLA_GUEST] click: all stamped handles on page (' + stampedHandles.length + ')', stampedHandles.slice(0, 20));

    // data-test-id shortcut
    var byTestId = document.querySelector('[data-test-id="' + handle + '"]');
    console.log('[SULLA_GUEST] click: data-test-id lookup', { found: !!byTestId });
    if (byTestId) { byTestId.click(); return true; }

    // Generic CSS selector fallback
    try {
      var generic = document.querySelector(handle);
      console.log('[SULLA_GUEST] click: CSS selector fallback', { found: !!generic });
      if (generic) { generic.click(); return true; }
    } catch (e) { console.log('[SULLA_GUEST] click: CSS selector threw', e); }

    console.log('[SULLA_GUEST] click: ALL resolution strategies failed for handle', handle);
    return false;
  };

  /**
   * setValue(handle, value)
   * Sets the value of a form field identified by @field-<id|name>.
   */
  bridge.setValue = function (handle, value) {
    // Primary: resolve via stamped data-sulla-handle attribute
    var el = findByHandle(handle);

    // Fallback: try by id or name
    if (!el) {
      var id = handle;
      if (handle.indexOf('@field-') === 0) {
        id = handle.slice(7);
      }
      el = document.getElementById(id)
            || document.querySelector('[name="' + id + '"]');
    }

    if (!el) return false;

    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    );
    var nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );

    if (el.tagName === 'TEXTAREA' && nativeTextareaValueSetter && nativeTextareaValueSetter.set) {
      nativeTextareaValueSetter.set.call(el, value);
    } else if (nativeInputValueSetter && nativeInputValueSetter.set) {
      nativeInputValueSetter.set.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  /**
   * getFormValues()
   * Returns a map of all visible form field values.
   */
  bridge.getFormValues = function () {
    var result = {};
    var fields = document.querySelectorAll('input, textarea, select');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (!isVisible(el)) continue;
      var key = el.id || el.name || ('idx-' + i);
      result[key] = el.value || '';
    }
    return result;
  };

  /**
   * waitForSelector(selector, timeoutMs)
   * Waits for a selector to become visible. Returns true/false.
   */
  bridge.waitForSelector = function (selector, timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    return new Promise(function (resolve) {
      var existing = document.querySelector(selector);
      if (existing && isVisible(existing)) { resolve(true); return; }

      var elapsed = 0;
      var interval = 200;
      var timer = setInterval(function () {
        elapsed += interval;
        var el = document.querySelector(selector);
        if (el && isVisible(el)) {
          clearInterval(timer);
          resolve(true);
        } else if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, interval);
    });
  };

  /**
   * scrollTo(selector)
   * Scrolls the matching element into view.
   */
  bridge.scrollTo = function (selector) {
    var el = document.querySelector(selector);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }
    return false;
  };

  /**
   * getPageText()
   * Returns the visible innerText of the page body.
   */
  bridge.getPageText = function () {
    return (document.body.innerText || '').slice(0, 50000);
  };

  // Expose globally
  window[GLOBAL] = bridge;

  /* ------------------------------------------------------------------ */
  /*  Passive event streaming to host                                   */
  /* ------------------------------------------------------------------ */

  // Click listener
  document.addEventListener('click', function (e) {
    var source = e.target;
    var target = source && typeof source.closest === 'function'
      ? source.closest('button, [role="button"], a[href], [data-test-id], input, textarea, select')
      : null;
    if (!target) return;

    emitToHost('sulla:click', {
      text: (target.textContent || '').trim().slice(0, 120),
      tagName: target.tagName,
      id: target.id || '',
      name: target.name || '',
      dataTestId: target.getAttribute('data-test-id') || '',
      disabled: !!target.disabled,
      timestamp: Date.now(),
    });
  }, true);

  // Route / URL change listener (SPA-friendly)
  var lastPathname = location.href;
  function checkRouteChange() {
    if (location.href !== lastPathname) {
      lastPathname = location.href;
      emitToHost('sulla:routeChanged', {
        url: location.href,
        path: location.pathname + location.hash,
        title: document.title,
        timestamp: Date.now(),
      });
    }
  }
  setInterval(checkRouteChange, 500);

  // Also catch pushState / replaceState
  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    checkRouteChange();
  };
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    checkRouteChange();
  };
  window.addEventListener('popstate', checkRouteChange);

  // Emit initial injection event
  emitToHost('sulla:injected', {
    url: location.href,
    title: document.title,
    timestamp: Date.now(),
  });

  /* ------------------------------------------------------------------ */
  /*  Smart DOM MutationObserver                                        */
  /*  Watches for meaningful changes, debounces, and streams compact    */
  /*  summaries back to the host.                                       */
  /* ------------------------------------------------------------------ */
  (function initMutationObserver() {
    var DEBOUNCE_MS = 300;
    var MAX_SUMMARY_ITEMS = 30;
    var pendingAdded = [];
    var pendingRemoved = [];
    var pendingTextChanges = [];
    var pendingAttrChanges = [];
    var flushTimer = null;

    // Track which text nodes we've seen to detect real changes
    var knownTexts = new WeakMap();

    function describeEl(el) {
      if (!el || el.nodeType !== 1) return null;
      var tag = el.tagName.toLowerCase();
      var handle = el.getAttribute('data-sulla-handle') || '';
      var text = (el.textContent || '').trim().slice(0, 80);
      var id = el.id || '';
      var testId = el.getAttribute('data-test-id') || '';
      var role = el.getAttribute('role') || '';
      return { tag: tag, handle: handle, text: text, id: id, testId: testId, role: role };
    }

    function isInteractive(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = el.tagName.toLowerCase();
      if (['button', 'a', 'input', 'textarea', 'select', 'form', 'dialog', 'details', 'summary'].indexOf(tag) !== -1) return true;
      var role = el.getAttribute('role') || '';
      if (['button', 'link', 'dialog', 'alert', 'alertdialog', 'tab', 'tabpanel', 'menu', 'menuitem', 'listbox', 'option'].indexOf(role) !== -1) return true;
      if (el.getAttribute('data-test-id')) return true;
      if (el.getAttribute('data-sulla-handle')) return true;
      return false;
    }

    function findInteractiveParentOrSelf(el) {
      var cur = el;
      while (cur && cur !== document.body) {
        if (isInteractive(cur)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    function isIgnored(el) {
      if (!el || el.nodeType !== 1) return true;
      var tag = el.tagName.toLowerCase();
      if (['script', 'style', 'link', 'meta', 'noscript', 'svg', 'path', 'br', 'hr'].indexOf(tag) !== -1) return true;
      // Ignore animation/transition-only elements
      var style = null;
      try { style = window.getComputedStyle(el); } catch(_) { return false; }
      if (style && style.display === 'none' && !el.getAttribute('role')) return true;
      return false;
    }

    function stampNewElements(el) {
      if (!el || el.nodeType !== 1) return;
      // Stamp interactive elements that don't already have a handle
      var targets = el.querySelectorAll ? el.querySelectorAll('button, [role="button"], a[href], input, textarea, select, [data-test-id]') : [];
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (t.getAttribute('data-sulla-handle')) continue;
        var text = (t.textContent || '').trim().slice(0, 60);
        var tag = t.tagName.toLowerCase();
        var prefix = tag === 'a' ? '@link-' : (tag === 'input' || tag === 'textarea' || tag === 'select') ? '@field-' : '@btn-';
        var slug = '';
        if (prefix === '@field-') {
          slug = t.id || t.name || 'auto-' + Math.random().toString(36).slice(2, 8);
        } else {
          slug = handleize(text) || t.id || t.getAttribute('data-test-id') || 'auto-' + Math.random().toString(36).slice(2, 8);
        }
        var newHandle = prefix + slug;
        stampHandle(t, newHandle);
      }
      // Also stamp the element itself if interactive
      if (isInteractive(el) && !el.getAttribute('data-sulla-handle')) {
        var selfText = (el.textContent || '').trim().slice(0, 60);
        var selfTag = el.tagName.toLowerCase();
        var selfPrefix = selfTag === 'a' ? '@link-' : (selfTag === 'input' || selfTag === 'textarea' || selfTag === 'select') ? '@field-' : '@btn-';
        var selfSlug = selfPrefix === '@field-' ? (el.id || el.name || 'auto-' + Math.random().toString(36).slice(2, 8)) : (handleize(selfText) || el.id || el.getAttribute('data-test-id') || 'auto-' + Math.random().toString(36).slice(2, 8));
        stampHandle(el, selfPrefix + selfSlug);
      }
    }

    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(flush, DEBOUNCE_MS);
    }

    function flush() {
      flushTimer = null;
      if (!pendingAdded.length && !pendingRemoved.length && !pendingTextChanges.length && !pendingAttrChanges.length) return;

      var summary = [];

      // Deduplicate and describe added elements
      var addedDescs = [];
      var seenAdded = {};
      for (var a = 0; a < pendingAdded.length && addedDescs.length < MAX_SUMMARY_ITEMS; a++) {
        var d = describeEl(pendingAdded[a]);
        if (!d || !d.text && !d.handle && !d.testId) continue;
        var key = d.tag + ':' + (d.handle || d.text || d.id);
        if (seenAdded[key]) continue;
        seenAdded[key] = true;
        addedDescs.push(d);
      }
      if (addedDescs.length > 0) {
        var addedParts = addedDescs.map(function(d) {
          return (d.handle || d.tag) + (d.text ? ' "' + d.text.slice(0, 40) + '"' : '');
        });
        summary.push('Added: ' + addedParts.join(', '));
      }

      // Removed
      var removedDescs = [];
      var seenRemoved = {};
      for (var r = 0; r < pendingRemoved.length && removedDescs.length < MAX_SUMMARY_ITEMS; r++) {
        var rd = pendingRemoved[r];
        if (!rd || !rd.text && !rd.handle && !rd.testId) continue;
        var rkey = rd.tag + ':' + (rd.handle || rd.text || rd.id);
        if (seenRemoved[rkey]) continue;
        seenRemoved[rkey] = true;
        removedDescs.push(rd);
      }
      if (removedDescs.length > 0) {
        var removedParts = removedDescs.map(function(d) {
          return (d.handle || d.tag) + (d.text ? ' "' + d.text.slice(0, 40) + '"' : '');
        });
        summary.push('Removed: ' + removedParts.join(', '));
      }

      // Text changes
      if (pendingTextChanges.length > 0) {
        var textParts = [];
        var seenText = {};
        for (var t = 0; t < pendingTextChanges.length && textParts.length < MAX_SUMMARY_ITEMS; t++) {
          var tc = pendingTextChanges[t];
          var tkey = tc.handle || tc.tag + ':' + tc.id;
          if (seenText[tkey]) continue;
          seenText[tkey] = true;
          textParts.push((tc.handle || tc.tag) + ' → "' + tc.newText.slice(0, 40) + '"');
        }
        summary.push('Text changed: ' + textParts.join(', '));
      }

      // Attribute changes (visibility, disabled state)
      if (pendingAttrChanges.length > 0) {
        var attrParts = [];
        var seenAttr = {};
        for (var at = 0; at < pendingAttrChanges.length && attrParts.length < MAX_SUMMARY_ITEMS; at++) {
          var ac = pendingAttrChanges[at];
          var atkey = ac.handle || ac.tag + ':' + ac.id;
          if (seenAttr[atkey]) continue;
          seenAttr[atkey] = true;
          attrParts.push((ac.handle || ac.tag) + ' ' + ac.attr + '=' + ac.value);
        }
        summary.push('Attrs: ' + attrParts.join(', '));
      }

      pendingAdded = [];
      pendingRemoved = [];
      pendingTextChanges = [];
      pendingAttrChanges = [];

      if (summary.length === 0) return;

      emitToHost('sulla:domChange', {
        summary: summary.join(' | '),
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      });
    }

    var observer = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var mut = mutations[m];

        // Added nodes
        if (mut.addedNodes) {
          for (var a = 0; a < mut.addedNodes.length; a++) {
            var added = mut.addedNodes[a];
            if (added.nodeType === 1) {
              if (isIgnored(added)) continue;
              stampNewElements(added);
              var interactiveAdded = findInteractiveParentOrSelf(added);
              if (interactiveAdded) {
                pendingAdded.push(interactiveAdded);
              } else if ((added.textContent || '').trim().length > 10) {
                // Non-interactive but has meaningful text content (like a notification/toast/alert)
                pendingAdded.push(added);
              }
            }
          }
        }

        // Removed nodes — snapshot description before they're gone
        if (mut.removedNodes) {
          for (var r = 0; r < mut.removedNodes.length; r++) {
            var removed = mut.removedNodes[r];
            if (removed.nodeType === 1 && !isIgnored(removed)) {
              var desc = describeEl(removed);
              if (desc && (desc.handle || desc.text || desc.testId)) {
                pendingRemoved.push(desc);
              }
            }
          }
        }

        // Character data changes (text node changes)
        if (mut.type === 'characterData') {
          var parent = mut.target.parentElement;
          if (parent && !isIgnored(parent)) {
            var interactive = findInteractiveParentOrSelf(parent);
            var el = interactive || parent;
            var newText = (el.textContent || '').trim().slice(0, 80);
            var oldText = knownTexts.get(el) || '';
            if (newText !== oldText) {
              knownTexts.set(el, newText);
              pendingTextChanges.push({
                tag: el.tagName.toLowerCase(),
                handle: el.getAttribute('data-sulla-handle') || '',
                id: el.id || '',
                newText: newText,
              });
            }
          }
        }

        // Attribute changes
        if (mut.type === 'attributes') {
          var attrEl = mut.target;
          if (attrEl.nodeType === 1 && !isIgnored(attrEl)) {
            var attrName = mut.attributeName || '';
            // Only track meaningful attribute changes
            if (['disabled', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-selected', 'class', 'open', 'data-state'].indexOf(attrName) !== -1) {
              var interactiveAttr = findInteractiveParentOrSelf(attrEl);
              if (interactiveAttr || isInteractive(attrEl)) {
                var target = interactiveAttr || attrEl;
                pendingAttrChanges.push({
                  tag: target.tagName.toLowerCase(),
                  handle: target.getAttribute('data-sulla-handle') || '',
                  id: target.id || '',
                  attr: attrName,
                  value: String(target.getAttribute(attrName) || '').slice(0, 40),
                });
              }
            }
          }
        }
      }

      if (pendingAdded.length || pendingRemoved.length || pendingTextChanges.length || pendingAttrChanges.length) {
        scheduleFlush();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-selected', 'class', 'open', 'data-state'],
    });
  })();

  /* ------------------------------------------------------------------ */
  /*  Alert / Confirm / Prompt interception                             */
  /*  Captures dialog content and streams it to the host before the     */
  /*  native dialog fires.                                              */
  /* ------------------------------------------------------------------ */
  (function interceptDialogs() {
    var origAlert = window.alert;
    var origConfirm = window.confirm;
    var origPrompt = window.prompt;

    window.alert = function (msg) {
      emitToHost('sulla:dialog', {
        dialogType: 'alert',
        message: String(msg || '').slice(0, 2000),
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      });
      return origAlert.call(window, msg);
    };

    window.confirm = function (msg) {
      emitToHost('sulla:dialog', {
        dialogType: 'confirm',
        message: String(msg || '').slice(0, 2000),
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      });
      return origConfirm.call(window, msg);
    };

    window.prompt = function (msg, defaultVal) {
      emitToHost('sulla:dialog', {
        dialogType: 'prompt',
        message: String(msg || '').slice(0, 2000),
        defaultValue: String(defaultVal || ''),
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      });
      return origPrompt.call(window, msg, defaultVal);
    };
  })();

})();
`;
}

export { BRIDGE_CHANNEL, GLOBAL_NAME };
