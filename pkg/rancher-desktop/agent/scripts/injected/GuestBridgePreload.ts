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

import { buildSullaRuntimeScript } from './SullaRuntime';

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

    // WebContentsView preload path (set by browserTabPreload.ts)
    // This is the preferred path when running inside a WebContentsView tab,
    // as it uses ipcRenderer.send() directly to the main process.
    try {
      if (typeof window.__sullaBridgeEmit === 'function') {
        window.__sullaBridgeEmit(type, data);
        return;
      }
    } catch (_) {}

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
    // Walk up the DOM within this document checking computed styles.
    // We intentionally avoid offsetParent / getBoundingClientRect because
    // those report zero dimensions when the containing iframe is hidden
    // via display:none (v-show on the parent page), even though the
    // elements are perfectly valid within the iframe's own DOM.
    var cur = el;
    while (cur && cur !== document.documentElement) {
      var style = window.getComputedStyle(cur);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      cur = cur.parentElement;
    }
    return true;
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
      // Fall back to aria-label for icon-only buttons
      if (!text) {
        text = (btn.getAttribute('aria-label') || '').trim().slice(0, 60);
      }
      if (!text) continue;
      var slug = handleize(text);
      if (!slug) continue;
      var handle = uniqueHandle('@btn-' + slug);
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
      // Fall back to aria-label for links with no visible text (icons, images, Google Maps results)
      if (!linkText) {
        linkText = (link.getAttribute('aria-label') || '').trim().slice(0, 60);
      }
      if (!linkText) continue;
      var linkSlug = handleize(linkText);
      if (!linkSlug) continue;
      var href = link.getAttribute('href') || '';
      var linkHandle = uniqueHandle('@link-' + linkSlug);
      stampHandle(link, linkHandle);
      lines.push('- **' + linkHandle + '** "' + linkText + '" → ' + href);
    }

    // Clickable items — ARIA roles and elements with tabindex/onclick that
    // aren't already captured as buttons or links (Google Maps listings, etc.)
    lines.push('');
    lines.push('## Clickable Items');
    var clickableSelector = [
      '[role="link"]:not(a):not(button)',
      '[role="menuitem"]:not(a):not(button)',
      '[role="option"]:not(a):not(button)',
      '[role="tab"]:not(a):not(button)',
      '[role="listitem"][tabindex]',
      '[role="article"][tabindex]',
      '[role="treeitem"]',
      '[data-result-index]',
      'div[tabindex="0"][role]',
    ].join(', ');
    var clickables = document.querySelectorAll(clickableSelector);
    for (var ci = 0; ci < clickables.length; ci++) {
      var item = clickables[ci];
      if (!isVisible(item)) continue;
      if (item.getAttribute('data-sulla-handle')) continue; // already stamped
      var itemText = (item.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!itemText || itemText.length < 3) continue;
      var itemRole = item.getAttribute('role') || 'item';
      var itemHandle = uniqueHandle('@item-' + handleize(itemText.slice(0, 40)));
      stampHandle(item, itemHandle);
      lines.push('- **' + itemHandle + '** (' + itemRole + ') "' + itemText + '"');
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

    var el = null;

    // Primary: resolve via stamped data-sulla-handle attribute
    var stamped = findByHandle(handle);
    console.log('[SULLA_GUEST] click: findByHandle result', { found: !!stamped, selector: '[data-sulla-handle=\"' + handle + '\"]' });
    if (stamped) { el = stamped; }

    // Debug: dump all stamped handles on the page
    if (!el) {
      var allStamped = document.querySelectorAll('[data-sulla-handle]');
      var stampedHandles = [];
      for (var s = 0; s < allStamped.length; s++) { stampedHandles.push(allStamped[s].getAttribute('data-sulla-handle')); }
      console.log('[SULLA_GUEST] click: all stamped handles on page (' + stampedHandles.length + ')', stampedHandles.slice(0, 20));
    }

    // data-test-id shortcut
    if (!el) {
      var byTestId = document.querySelector('[data-test-id="' + handle + '"]');
      console.log('[SULLA_GUEST] click: data-test-id lookup', { found: !!byTestId });
      if (byTestId) { el = byTestId; }
    }

    // Generic CSS selector fallback — supports [n] index suffix for querySelectorAll
    // e.g. "div.Nv2PK[1]" clicks the 2nd match, "div.Nv2PK" clicks the 1st
    if (!el) {
      try {
        var indexMatch = handle.match(/^(.+)\[(\d+)\]$/);
        if (indexMatch) {
          var allMatches = document.querySelectorAll(indexMatch[1]);
          var idx = parseInt(indexMatch[2], 10);
          if (allMatches[idx]) { el = allMatches[idx]; }
          console.log('[SULLA_GUEST] click: CSS selector with index', { selector: indexMatch[1], index: idx, found: !!el, total: allMatches.length });
        } else {
          var generic = document.querySelector(handle);
          console.log('[SULLA_GUEST] click: CSS selector fallback', { found: !!generic });
          if (generic) { el = generic; }
        }
      } catch (e) { console.log('[SULLA_GUEST] click: CSS selector threw', e); }
    }

    if (!el) {
      console.log('[SULLA_GUEST] click: ALL resolution strategies failed for handle', handle);
      return false;
    }

    // Strip target="_blank" from links so navigation stays inside the iframe
    var anchor = el.closest ? el.closest('a[target]') : null;
    if (!anchor && el.tagName === 'A' && el.hasAttribute('target')) { anchor = el; }
    if (anchor) {
      console.log('[SULLA_GUEST] click: stripping target attribute from link', { href: anchor.href, target: anchor.getAttribute('target') });
      anchor.removeAttribute('target');
    }

    console.log('[SULLA_GUEST] click: clicking element', { tag: el.tagName, id: el.id, text: (el.textContent || '').slice(0, 60) });
    el.click();
    return true;
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
   * focusElement(handle?)
   * Focuses a target element by handle, CSS selector, or falls back to the active element.
   * Used before sending trusted keyboard events via Electron's main process.
   */
  bridge.focusElement = function (handle) {
    var target = null;
    if (handle && handle !== 'undefined') {
      target = findByHandle(handle);
      if (!target) { target = document.querySelector('[data-test-id="' + handle + '"]'); }
      if (!target) {
        try {
          var fiMatch = handle.match(/^(.+)\[(\d+)\]$/);
          if (fiMatch) {
            var fiAll = document.querySelectorAll(fiMatch[1]);
            target = fiAll[parseInt(fiMatch[2], 10)] || null;
          } else {
            target = document.querySelector(handle);
          }
        } catch (e) { /* ignore */ }
      }
    }
    if (!target) { target = document.activeElement || document.body; }
    if (typeof target.focus === 'function') { target.focus(); }
    // Also click into the element to ensure it's truly active (some SPAs need this)
    if (typeof target.click === 'function' && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      target.click();
    }
    return true;
  };

  /**
   * pressKey(key, handle?)
   * Dispatches keydown, keypress, keyup events for the given key.
   * If handle is provided, targets that element; otherwise uses the focused element.
   */
  bridge.pressKey = function (key, handle) {
    var keyCodeMap = {
      'Enter': 13, 'Escape': 27, 'Tab': 9,
      'ArrowDown': 40, 'ArrowUp': 38, 'ArrowLeft': 37, 'ArrowRight': 39,
      'Backspace': 8, 'Space': 32
    };

    var target = null;

    if (handle) {
      // Primary: resolve via stamped data-sulla-handle attribute
      target = findByHandle(handle);

      // data-test-id shortcut
      if (!target) {
        target = document.querySelector('[data-test-id="' + handle + '"]');
      }

      // Generic CSS selector — supports [n] index suffix for querySelectorAll
      if (!target) {
        try {
          var pIndexMatch = handle.match(/^(.+)\[(\d+)\]$/);
          if (pIndexMatch) {
            var pAll = document.querySelectorAll(pIndexMatch[1]);
            var pIdx = parseInt(pIndexMatch[2], 10);
            if (pAll[pIdx]) { target = pAll[pIdx]; }
          } else {
            target = document.querySelector(handle);
          }
        } catch (e) { /* ignore invalid selector */ }
      }
    }

    // Fall back to focused element, then document.body
    if (!target) {
      target = document.activeElement || document.body;
    }

    var code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    var keyCode = keyCodeMap[key] || 0;
    var eventProps = {
      key: key,
      code: code,
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true
    };

    try {
      // Focus the target so the page recognizes it as the active element
      if (typeof target.focus === 'function') {
        target.focus();
      }

      target.dispatchEvent(new KeyboardEvent('keydown', eventProps));
      target.dispatchEvent(new KeyboardEvent('keypress', eventProps));
      target.dispatchEvent(new KeyboardEvent('keyup', eventProps));

      // For Enter: synthetic KeyboardEvent has isTrusted=false so many sites
      // ignore it. We use multiple fallback strategies to trigger submission.
      if (key === 'Enter') {
        var form = target.closest ? target.closest('form') : null;
        if (form) {
          // Try requestSubmit (fires submit event handlers) then fall back to submit()
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            form.submit();
          }
        } else {
          // No form — try clicking the nearest search/submit button as fallback.
          // Walk up from the target looking for a container with a button.
          var searchBtn = null;
          var container = target.parentElement;
          for (var depth = 0; depth < 5 && container && !searchBtn; depth++) {
            // Look for submit-like buttons by type, aria-label, or role
            searchBtn = container.querySelector(
              'button[type="submit"], input[type="submit"], ' +
              'button[aria-label*="earch"], button[aria-label*="ubmit"], ' +
              'button[aria-label*="Go"], button[jsaction*="search"]'
            );
            container = container.parentElement;
          }
          if (searchBtn) {
            console.log('[SULLA_GUEST] pressKey: Enter fallback — clicking submit button', { tag: searchBtn.tagName, label: searchBtn.getAttribute('aria-label') });
            searchBtn.click();
          }
        }
      }

      return true;
    } catch (e) {
      console.log('[SULLA_GUEST] pressKey error', e);
      return false;
    }
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

  /**
   * getReaderContent(maxChars)
   * Extracts the main readable content of the page in a structured,
   * token-efficient format — similar to browser "reader view".
   * Strips nav, ads, sidebars, footers, and boilerplate.
   * Returns { title, url, content, contentLength, truncated }
   */
  bridge.getReaderContent = function (maxChars) {
    maxChars = maxChars || 12000;

    // --- Find main content container ---
    var main = document.querySelector('main, article, [role="main"]');
    if (!main) {
      // Heuristic: find the largest text-dense block
      var candidates = document.querySelectorAll('div, section');
      var bestLen = 0;
      for (var ci = 0; ci < candidates.length; ci++) {
        var c = candidates[ci];
        var cText = (c.innerText || '').trim();
        if (cText.length > bestLen) {
          bestLen = cText.length;
          main = c;
        }
      }
    }
    if (!main) main = document.body;

    // --- Tags/selectors to strip ---
    var STRIP_SELECTORS = 'script, style, noscript, nav, header, footer, aside, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      '[aria-hidden="true"], .ad, .ads, .advertisement, .sidebar, ' +
      '.cookie-banner, .popup, .modal, .nav, .menu, .footer, .header';

    // --- Clone and clean ---
    var clone = main.cloneNode(true);
    var stripped = clone.querySelectorAll(STRIP_SELECTORS);
    for (var si = 0; si < stripped.length; si++) {
      stripped[si].parentNode && stripped[si].parentNode.removeChild(stripped[si]);
    }

    // --- Walk DOM and produce structured text ---
    var output = [];
    var charCount = 0;
    var truncated = false;

    function addLine(line) {
      if (truncated) return;
      if (charCount + line.length > maxChars) {
        output.push(line.slice(0, maxChars - charCount));
        truncated = true;
        return;
      }
      output.push(line);
      charCount += line.length + 1; // +1 for newline
    }

    function walkNode(node) {
      if (truncated) return;
      if (node.nodeType === 3) {
        // Text node
        var text = (node.textContent || '').trim();
        if (text) addLine(text);
        return;
      }
      if (node.nodeType !== 1) return;

      var tag = node.tagName.toLowerCase();

      // Skip hidden elements
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
      try {
        var style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;
      } catch (_) {}

      // Headings
      var headingMatch = tag.match(/^h([1-6])$/);
      if (headingMatch) {
        var level = parseInt(headingMatch[1], 10);
        var prefix = '';
        for (var hi = 0; hi < level; hi++) prefix += '#';
        var hText = (node.innerText || '').trim();
        if (hText) {
          addLine('');
          addLine(prefix + ' ' + hText);
          addLine('');
        }
        return; // don't recurse into heading children
      }

      // List items
      if (tag === 'li') {
        var liText = (node.innerText || '').trim();
        if (liText) addLine('- ' + liText.split('\\n')[0]);
        return;
      }

      // Table rows
      if (tag === 'tr') {
        var cells = node.querySelectorAll('td, th');
        var rowParts = [];
        for (var ri = 0; ri < cells.length; ri++) {
          var cellText = (cells[ri].innerText || '').trim();
          if (cellText) rowParts.push(cellText);
        }
        if (rowParts.length) addLine('| ' + rowParts.join(' | ') + ' |');
        return;
      }

      // Blockquote
      if (tag === 'blockquote') {
        var bqText = (node.innerText || '').trim();
        if (bqText) addLine('> ' + bqText.split('\\n').join('\\n> '));
        return;
      }

      // Paragraph / div — recurse into children
      if (tag === 'p') {
        var pText = (node.innerText || '').trim();
        if (pText) {
          addLine('');
          addLine(pText);
        }
        return;
      }

      // Links — inline, just recurse
      if (tag === 'a') {
        var linkText = (node.innerText || '').trim();
        var href = node.getAttribute('href') || '';
        if (linkText && href && href.indexOf('#') !== 0) {
          addLine('[' + linkText + '](' + href + ')');
        } else if (linkText) {
          addLine(linkText);
        }
        return;
      }

      // Images with alt text
      if (tag === 'img') {
        var alt = node.getAttribute('alt') || '';
        if (alt) addLine('[Image: ' + alt + ']');
        return;
      }

      // Pre/code blocks
      if (tag === 'pre' || tag === 'code') {
        var codeText = (node.innerText || '').trim();
        if (codeText) {
          var fence = '\x60\x60\x60';
          addLine('');
          addLine(fence);
          addLine(codeText);
          addLine(fence);
          addLine('');
        }
        return;
      }

      // Default: recurse into children
      var children = node.childNodes;
      for (var i = 0; i < children.length; i++) {
        walkNode(children[i]);
      }
    }

    walkNode(clone);

    // Clean up: collapse excessive blank lines
    var content = output.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();

    return {
      title: document.title || '',
      url: location.href,
      content: content,
      contentLength: content.length,
      truncated: truncated,
    };
  };

  /* ------------------------------------------------------------------ */
  /*  Scroll tracking and incremental content capture                   */
  /* ------------------------------------------------------------------ */

  var sentParagraphHashes = {};
  var scrollOpCount = 0;
  var MAX_SCROLL_OPS = 20;

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  /**
   * getScrollInfo()
   * Returns current scroll position info.
   */
  bridge.getScrollInfo = function () {
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    var viewportHeight = window.innerHeight || 0;
    var maxScroll = Math.max(0, scrollHeight - viewportHeight);
    var percent = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 100;

    return {
      scrollY: Math.round(scrollY),
      scrollHeight: scrollHeight,
      viewportHeight: viewportHeight,
      percent: percent,
      atTop: scrollY < 10,
      atBottom: (scrollY + viewportHeight) >= (scrollHeight - 10),
      moreBelow: (scrollY + viewportHeight) < (scrollHeight - 10),
      moreAbove: scrollY > 10,
    };
  };

  /**
   * scrollAndCapture(direction)
   * Smooth-scrolls one viewport in the given direction, waits for content
   * to settle, then extracts only NEW content that hasn't been sent before.
   * Returns { newContent, scrollInfo, noNewContent }
   */
  bridge.scrollAndCapture = function (direction) {
    direction = direction || 'down';
    scrollOpCount++;

    return new Promise(function (resolve) {
      var scrollAmount = Math.round(window.innerHeight * 0.8);
      if (direction === 'up') scrollAmount = -scrollAmount;

      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });

      // Wait for scroll animation + lazy content to load
      setTimeout(function () {
        // Extract reader content from current viewport area
        var content = bridge.getReaderContent(4000);
        if (!content || !content.content) {
          resolve({ newContent: '', scrollInfo: bridge.getScrollInfo(), noNewContent: true });
          return;
        }

        // Deduplicate: split into paragraphs and only keep new ones
        var paragraphs = content.content.split('\\n\\n');
        var newParagraphs = [];
        for (var i = 0; i < paragraphs.length; i++) {
          var p = paragraphs[i].trim();
          if (!p || p.length < 20) continue;
          var h = hashStr(p);
          if (!sentParagraphHashes[h]) {
            sentParagraphHashes[h] = true;
            newParagraphs.push(p);
          }
        }

        var newContent = newParagraphs.join('\\n\\n').trim();
        resolve({
          newContent: newContent.slice(0, 4000),
          scrollInfo: bridge.getScrollInfo(),
          noNewContent: newContent.length === 0,
        });
      }, 800);
    });
  };

  /**
   * scrollToTop()
   * Scrolls to the top of the page.
   */
  bridge.scrollToTop = function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    scrollOpCount = 0;
    sentParagraphHashes = {};
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(bridge.getScrollInfo());
      }, 500);
    });
  };

  /**
   * searchInPage(query)
   * Searches for text within the page content.
   * Returns up to 3 matches with surrounding context.
   */
  bridge.searchInPage = function (query) {
    if (!query) return { matches: [], total: 0 };

    var text = (document.body.innerText || '');
    var lowerText = text.toLowerCase();
    var lowerQuery = query.toLowerCase();
    var matches = [];
    var startIdx = 0;
    var CONTEXT_CHARS = 200;
    var MAX_MATCHES = 5;

    while (matches.length < MAX_MATCHES) {
      var idx = lowerText.indexOf(lowerQuery, startIdx);
      if (idx === -1) break;

      var ctxStart = Math.max(0, idx - CONTEXT_CHARS);
      var ctxEnd = Math.min(text.length, idx + query.length + CONTEXT_CHARS);
      var context = text.slice(ctxStart, ctxEnd);
      if (ctxStart > 0) context = '...' + context;
      if (ctxEnd < text.length) context = context + '...';

      matches.push({
        index: idx,
        context: context,
      });

      startIdx = idx + query.length;
    }

    // Count total occurrences
    var total = 0;
    var countIdx = 0;
    while (true) {
      countIdx = lowerText.indexOf(lowerQuery, countIdx);
      if (countIdx === -1) break;
      total++;
      countIdx += lowerQuery.length;
    }

    return { matches: matches, total: total, query: query };
  };

  /* ------------------------------------------------------------------ */
  /*  Vault: in-page login detection, dropdown, save toast              */
  /*  Injected directly into the guest DOM like Bitwarden/1Password.    */
  /* ------------------------------------------------------------------ */

  /**
   * detectLoginForm()
   * Scans the page for login forms containing password fields.
   */
  bridge.detectLoginForm = function () {
    var passwordFields = document.querySelectorAll('input[type="password"]');
    if (passwordFields.length === 0) return null;

    for (var pi = 0; pi < passwordFields.length; pi++) {
      var pwField = passwordFields[pi];
      if (!isVisible(pwField)) continue;
      var autocomplete = (pwField.getAttribute('autocomplete') || '').toLowerCase();
      if (autocomplete.indexOf('cc-') === 0) continue;

      var form = pwField.closest ? pwField.closest('form') : null;
      var searchRoot = form || (pwField.parentElement ? pwField.parentElement.parentElement : document.body) || document.body;

      var usernameField = null;
      var candidates = searchRoot.querySelectorAll('input[type="email"], input[type="text"], input[type="tel"]');
      for (var ci = 0; ci < candidates.length; ci++) {
        var c = candidates[ci];
        if (!isVisible(c)) continue;
        var cName = ((c.name || '') + ' ' + (c.id || '') + ' ' + (c.getAttribute('autocomplete') || '') + ' ' + (c.placeholder || '')).toLowerCase();
        if (cName.match(/user|email|login|account|phone|ident/)) { usernameField = c; break; }
      }
      if (!usernameField) {
        var allInputs = searchRoot.querySelectorAll('input[type="email"], input[type="text"]');
        for (var ai = 0; ai < allInputs.length; ai++) {
          if (isVisible(allInputs[ai])) { usernameField = allInputs[ai]; break; }
        }
      }

      if (usernameField && !usernameField.getAttribute('data-sulla-handle')) stampHandle(usernameField, '@vault-username');
      if (!pwField.getAttribute('data-sulla-handle')) stampHandle(pwField, '@vault-password');

      return {
        hasLoginForm: true,
        usernameField: usernameField,
        passwordField: pwField,
        usernameHandle: usernameField ? (usernameField.getAttribute('data-sulla-handle') || '@vault-username') : null,
        passwordHandle: pwField.getAttribute('data-sulla-handle') || '@vault-password',
        origin: location.origin,
      };
    }
    return null;
  };

  /**
   * autofillFromVault(accountId)
   * Requests the host to fill credentials. Password bypasses bridge.
   */
  bridge.autofillFromVault = function (accountId) {
    emitToHost('sulla:vault:autofillRequest', {
      accountId: accountId,
      origin: location.origin,
      timestamp: Date.now(),
    });
    return true;
  };

  // ── In-page vault dropdown (like Bitwarden) ──
  (function initVaultUI() {
    var DROPDOWN_ID = 'sulla-vault-dropdown';
    var TOAST_ID = 'sulla-vault-toast';
    var currentLoginForm = null;
    var vaultAccounts = []; // populated by host via __sullaVaultAccounts
    var dropdownTarget = null; // the input field the dropdown is anchored to

    // Styles injected once
    var styleInjected = false;
    function injectStyles() {
      if (styleInjected) return;
      styleInjected = true;
      var style = document.createElement('style');
      style.textContent = [
        '#' + DROPDOWN_ID + ' {',
        '  position: absolute; z-index: 2147483647;',
        '  background: #1e1e2e; border: 1px solid #45475a; border-radius: 8px;',
        '  box-shadow: 0 8px 32px rgba(0,0,0,0.5); min-width: 260px; max-width: 340px;',
        '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
        '  font-size: 13px; color: #cdd6f4; overflow: hidden;',
        '}',
        '#' + DROPDOWN_ID + ' .sulla-vault-header {',
        '  display: flex; align-items: center; gap: 6px; padding: 8px 12px;',
        '  border-bottom: 1px solid #313244; font-size: 11px; color: #a6adc8;',
        '}',
        '#' + DROPDOWN_ID + ' .sulla-vault-header svg { width: 14px; height: 14px; }',
        '#' + DROPDOWN_ID + ' .sulla-vault-item {',
        '  display: flex; flex-direction: column; gap: 1px; padding: 8px 12px;',
        '  cursor: pointer; border: none; background: none; width: 100%;',
        '  text-align: left; color: #cdd6f4; transition: background 0.15s;',
        '}',
        '#' + DROPDOWN_ID + ' .sulla-vault-item:hover { background: #313244; }',
        '#' + DROPDOWN_ID + ' .sulla-vault-item-user { font-size: 13px; font-weight: 500; }',
        '#' + DROPDOWN_ID + ' .sulla-vault-item-origin { font-size: 11px; color: #6c7086; }',
        '#' + DROPDOWN_ID + ' .sulla-vault-empty {',
        '  padding: 12px; text-align: center; color: #6c7086; font-size: 12px;',
        '}',
        '#' + TOAST_ID + ' {',
        '  position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;',
        '  background: #1e1e2e; border: 1px solid #45475a; border-radius: 10px;',
        '  box-shadow: 0 8px 32px rgba(0,0,0,0.5); padding: 12px 16px;',
        '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
        '  font-size: 13px; color: #cdd6f4; display: flex; align-items: center; gap: 12px;',
        '  animation: sullaToastIn 0.3s ease-out;',
        '}',
        '#' + TOAST_ID + ' .sulla-toast-text { flex: 1; }',
        '#' + TOAST_ID + ' .sulla-toast-text strong { color: #89b4fa; }',
        '#' + TOAST_ID + ' button {',
        '  padding: 4px 12px; border-radius: 6px; border: none; cursor: pointer;',
        '  font-size: 12px; font-weight: 600; transition: background 0.15s;',
        '}',
        '#' + TOAST_ID + ' .sulla-toast-save { background: #89b4fa; color: #1e1e2e; }',
        '#' + TOAST_ID + ' .sulla-toast-save:hover { background: #b4d0fb; }',
        '#' + TOAST_ID + ' .sulla-toast-dismiss { background: #313244; color: #a6adc8; }',
        '#' + TOAST_ID + ' .sulla-toast-dismiss:hover { background: #45475a; }',
        '@keyframes sullaToastIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }',
      ].join('\\n');
      document.head.appendChild(style);
    }

    // ── Dropdown ──

    function showDropdown(anchorEl) {
      removeDropdown();
      if (vaultAccounts.length === 0) return;
      injectStyles();

      dropdownTarget = anchorEl;
      var rect = anchorEl.getBoundingClientRect();
      var dropdown = document.createElement('div');
      dropdown.id = DROPDOWN_ID;

      // Header
      var header = document.createElement('div');
      header.className = 'sulla-vault-header';
      header.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Sulla Vault';
      dropdown.appendChild(header);

      // Account items
      for (var i = 0; i < vaultAccounts.length; i++) {
        (function(acct) {
          var item = document.createElement('button');
          item.className = 'sulla-vault-item';
          item.type = 'button';
          item.innerHTML = '<span class="sulla-vault-item-user">' + escapeHtml(acct.username) + '</span>' +
                           '<span class="sulla-vault-item-origin">' + escapeHtml(acct.origin || location.origin) + '</span>';
          item.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            bridge.autofillFromVault(acct.accountId);
            removeDropdown();
          });
          dropdown.appendChild(item);
        })(vaultAccounts[i]);
      }

      // Position below the input field
      dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      dropdown.style.left = (rect.left + window.scrollX) + 'px';
      dropdown.style.width = Math.max(rect.width, 260) + 'px';
      document.body.appendChild(dropdown);

      // Close on outside click
      setTimeout(function() {
        document.addEventListener('click', onOutsideClick, true);
        document.addEventListener('keydown', onEscapeKey, true);
      }, 0);
    }

    function removeDropdown() {
      var existing = document.getElementById(DROPDOWN_ID);
      if (existing) existing.remove();
      dropdownTarget = null;
      document.removeEventListener('click', onOutsideClick, true);
      document.removeEventListener('keydown', onEscapeKey, true);
    }

    function onOutsideClick(e) {
      var dropdown = document.getElementById(DROPDOWN_ID);
      if (dropdown && !dropdown.contains(e.target) && e.target !== dropdownTarget) {
        removeDropdown();
      }
    }

    function onEscapeKey(e) {
      if (e.key === 'Escape') removeDropdown();
    }

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // ── Save toast (after form submit) ──

    function showSaveToast(origin, username, action) {
      removeSaveToast();
      injectStyles();
      action = action || 'Save';

      var toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.innerHTML =
        '<div class="sulla-toast-text">' + action + ' password for <strong>' + escapeHtml(username) + '</strong> on ' + escapeHtml(origin.replace(/^https?:\\/\\//, '')) + '?</div>' +
        '<button class="sulla-toast-save" type="button">' + action + '</button>' +
        '<button class="sulla-toast-dismiss" type="button">Dismiss</button>';

      toast.querySelector('.sulla-toast-save').addEventListener('click', function() {
        emitToHost('sulla:vault:credentialsCaptured', {
          origin: origin, url: location.href,
          username: username,
          title: document.title, timestamp: Date.now(),
        });
        removeSaveToast();
      });
      toast.querySelector('.sulla-toast-dismiss').addEventListener('click', function() {
        emitToHost('sulla:vault:credentialsDismissed', { timestamp: Date.now() });
        removeSaveToast();
      });
      document.body.appendChild(toast);
      // No auto-dismiss — main process manages the 90s lifetime
    }

    function removeSaveToast() {
      var existing = document.getElementById(TOAST_ID);
      if (existing) existing.remove();
    }

    // ── Host communication ──

    // The host populates this array via executeJavaScript when it finds matches
    window.__sullaVaultAccounts = [];
    window.__sullaVaultShowPendingSaveToast = function(origin, username, action) {
      showSaveToast(origin, username, action);
    };

    window.__sullaVaultSetAccounts = function(accounts) {
      vaultAccounts = accounts || [];
      window.__sullaVaultAccounts = vaultAccounts;
      console.log('[SULLA_VAULT] Received', vaultAccounts.length, 'vault accounts for', location.origin);
      // If a login form field is focused and we have accounts, show dropdown
      if (vaultAccounts.length > 0) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT') && currentLoginForm) {
          if (active === currentLoginForm.usernameField || active === currentLoginForm.passwordField) {
            showDropdown(active);
          }
        }
      }
    };

    // ── Focus listeners on login fields ──

    function attachFieldListeners(loginForm) {
      var fields = [loginForm.usernameField, loginForm.passwordField].filter(Boolean);
      for (var i = 0; i < fields.length; i++) {
        (function(field) {
          if (field.__sullaVaultBound) return;
          field.__sullaVaultBound = true;
          field.addEventListener('focus', function() {
            if (vaultAccounts.length > 0) {
              showDropdown(field);
            } else {
              // Ask the host for matches
              emitToHost('sulla:vault:getMatches', { origin: location.origin, timestamp: Date.now() });
            }
          });
          field.addEventListener('blur', function() {
            // Delay removal so click on dropdown item can fire first
            setTimeout(function() {
              if (document.activeElement && document.getElementById(DROPDOWN_ID) &&
                  document.getElementById(DROPDOWN_ID).contains(document.activeElement)) return;
              removeDropdown();
            }, 200);
          });
        })(fields[i]);
      }
    }

    // ── Form submission interception ──

    var captured = false;
    function captureCredentials() {
      if (captured || !currentLoginForm) return;
      var usernameEl = currentLoginForm.usernameField;
      var passwordEl = currentLoginForm.passwordField;
      var username = usernameEl ? (usernameEl.value || '').trim() : '';
      var password = passwordEl ? (passwordEl.value || '') : '';
      if (!username || !password) return;

      captured = true;
      // Send credentials to main process for persistent storage across navigations.
      // The main process will push back the save toast (and re-push on navigation).
      emitToHost('sulla:vault:credentialsPending', {
        origin: location.origin, url: location.href,
        username: username, password: password,
        title: document.title, timestamp: Date.now(),
      });
      setTimeout(function() { captured = false; }, 5000);
    }

    document.addEventListener('submit', function(e) {
      var form = e.target;
      if (form && form.querySelector && form.querySelector('input[type="password"]')) {
        captureCredentials();
      }
    }, true);

    document.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || !target.closest) return;
      var btn = target.closest('button[type="submit"], input[type="submit"], button:not([type])');
      if (!btn) return;
      var form = btn.closest('form');
      if (form && form.querySelector('input[type="password"]')) {
        setTimeout(captureCredentials, 50);
      }
    }, true);

    // ── Login form detection + MutationObserver ──

    function checkForLoginForm() {
      var result = bridge.detectLoginForm();
      if (result && result.hasLoginForm) {
        currentLoginForm = result;
        attachFieldListeners(result);
        // Request vault matches from host
        emitToHost('sulla:vault:loginFormDetected', {
          origin: location.origin, url: location.href, timestamp: Date.now(),
        });
        emitToHost('sulla:vault:getMatches', {
          origin: location.origin, timestamp: Date.now(),
        });
      }
    }

    // Check on load
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(checkForLoginForm, 500);
    } else {
      document.addEventListener('DOMContentLoaded', function() { setTimeout(checkForLoginForm, 500); });
    }

    // Watch for SPA-rendered login forms
    var loginObserver = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if ((node.tagName === 'INPUT' && node.type === 'password') ||
              (node.querySelector && node.querySelector('input[type="password"]'))) {
            setTimeout(checkForLoginForm, 100);
            return;
          }
        }
      }
    });
    loginObserver.observe(document.documentElement, { childList: true, subtree: true });

    // Reset on SPA navigation
    var lastVaultUrl = location.href;
    setInterval(function() {
      if (location.href !== lastVaultUrl) {
        lastVaultUrl = location.href;
        currentLoginForm = null;
        vaultAccounts = [];
        removeDropdown();
        // Do NOT removeSaveToast — main process manages toast lifetime across navigations
        setTimeout(checkForLoginForm, 1000);
      }
    }, 500);
  })();

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
  var contentEmitTimer = null;
  function checkRouteChange() {
    if (location.href !== lastPathname) {
      lastPathname = location.href;
      emitToHost('sulla:routeChanged', {
        url: location.href,
        path: location.pathname + location.hash,
        title: document.title,
        timestamp: Date.now(),
      });
      // Re-emit reader content after navigation settles
      if (contentEmitTimer) clearTimeout(contentEmitTimer);
      contentEmitTimer = setTimeout(emitReaderContent, 1500);
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

  // Auto-emit reader content after page settles
  function emitReaderContent() {
    var content = bridge.getReaderContent();
    if (content && content.contentLength > 100) {
      emitToHost('sulla:pageContent', {
        title: content.title,
        url: content.url,
        content: content.content,
        contentLength: content.contentLength,
        truncated: content.truncated,
        timestamp: Date.now(),
      });
    }
  }

  // Emit content after initial page load settles
  setTimeout(emitReaderContent, 1500);

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

// ── Inject __sulla runtime library ──
${ buildSullaRuntimeScript() }
`;
}

export { BRIDGE_CHANNEL, GLOBAL_NAME };
