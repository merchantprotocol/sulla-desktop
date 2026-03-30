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

    // --- Content addition tracking (Tier 2) ---
    var CONTENT_DEBOUNCE_MS = 2000;
    var CONTENT_MIN_CHARS = 500;
    var CONTENT_MAX_CHARS = 2000;
    var CONTENT_THROTTLE_MS = 5000;
    var pendingContentText = 0;
    var contentFlushTimer = null;
    var lastContentEmitAt = 0;
    var pendingContentNodes = [];

    function scheduleContentFlush() {
      if (contentFlushTimer) return;
      contentFlushTimer = setTimeout(flushContentAdditions, CONTENT_DEBOUNCE_MS);
    }

    function flushContentAdditions() {
      contentFlushTimer = null;
      if (pendingContentText < CONTENT_MIN_CHARS) {
        pendingContentNodes = [];
        pendingContentText = 0;
        return;
      }

      // Throttle: don't emit more than once per CONTENT_THROTTLE_MS
      var now = Date.now();
      if (now - lastContentEmitAt < CONTENT_THROTTLE_MS) {
        pendingContentNodes = [];
        pendingContentText = 0;
        return;
      }

      // Extract text from pending nodes
      var parts = [];
      var charCount = 0;
      for (var i = 0; i < pendingContentNodes.length && charCount < CONTENT_MAX_CHARS; i++) {
        var text = (pendingContentNodes[i].innerText || pendingContentNodes[i].textContent || '').trim();
        if (text.length < 20) continue;
        parts.push(text);
        charCount += text.length;
      }

      pendingContentNodes = [];
      pendingContentText = 0;

      if (parts.length === 0) return;

      var combined = parts.join('\\n\\n').slice(0, CONTENT_MAX_CHARS);
      lastContentEmitAt = now;

      emitToHost('sulla:contentAdded', {
        content: combined,
        contentLength: combined.length,
        url: location.href,
        title: document.title,
        timestamp: now,
      });
    }

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
              // Track non-interactive content additions for contentAdded events
              var addedText = (added.textContent || '').trim();
              if (!interactiveAdded && addedText.length > 50) {
                pendingContentNodes.push(added);
                pendingContentText += addedText.length;
                scheduleContentFlush();
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
