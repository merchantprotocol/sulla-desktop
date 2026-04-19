/**
 * browserContextMenu.ts
 *
 * Builds a self-contained JavaScript string that, when injected into a
 * WebContentsView via executeJavaScript(), creates a Shadow DOM context
 * menu styled to match the Sulla desktop theme.
 *
 * The menu is a custom element (<sulla-context-menu>) with an attached
 * shadow root, so its styles and DOM are fully isolated from the host
 * page. Actions are dispatched back to the main process via the
 * `window.__sullaBridgeEmit` bridge set up by browserTabPreload.ts.
 */

export interface ContextMenuParams {
  tabId:                 string;
  x:                     number;
  y:                     number;
  selectionText:         string;
  linkURL:               string;
  srcURL:                string;
  mediaType:             string;
  isEditable:            boolean;
  misspelledWord:        string;
  dictionarySuggestions: string[];
  canGoBack:             boolean;
  canGoForward:          boolean;
  pageURL:               string;
}

/**
 * Returns a JS IIFE string ready to be passed to webContents.executeJavaScript().
 */
export function buildContextMenuInjection(ctx: ContextMenuParams): string {
  const items = buildMenuItems(ctx);

  // Escape for safe embedding in the JS string
  const itemsJSON = JSON.stringify(items);
  const ctxJSON = JSON.stringify(ctx);

  return `(function(){
${ MENU_RUNTIME }
__sullaCtxMenu(${ itemsJSON }, ${ ctxJSON });
})();`;
}

// ---------------------------------------------------------------------------
// Menu item builder
// ---------------------------------------------------------------------------

interface MenuItem {
  type:      'item' | 'separator' | 'header';
  label?:    string;
  shortcut?: string;
  icon?:     string;
  action?:   string;
  disabled?: boolean;
  data?:     Record<string, unknown>;
  cssClass?: string;
}

function buildMenuItems(ctx: ContextMenuParams): MenuItem[] {
  const items: MenuItem[] = [];

  // Spelling suggestions
  if (ctx.misspelledWord) {
    for (const s of ctx.dictionarySuggestions.slice(0, 5)) {
      items.push({ type: 'item', label: s, action: 'replace-selection', data: { text: s }, cssClass: 'spelling' });
    }
    if (ctx.dictionarySuggestions.length) {
      items.push({ type: 'separator' });
    }
    items.push({ type: 'item', label: 'Add to Dictionary', action: 'add-to-dictionary', icon: 'plus', data: { word: ctx.misspelledWord } });
    items.push({ type: 'separator' });
  }

  // Navigation
  if (ctx.canGoBack || ctx.canGoForward) {
    items.push({ type: 'item', label: 'Back', action: 'go-back', icon: 'chevron-left', disabled: !ctx.canGoBack });
    items.push({ type: 'item', label: 'Forward', action: 'go-forward', icon: 'chevron-right', disabled: !ctx.canGoForward });
  }
  items.push({ type: 'item', label: 'Reload', action: 'reload', icon: 'reload', shortcut: '\u2318R' });
  items.push({ type: 'separator' });

  // Link
  if (ctx.linkURL) {
    items.push({ type: 'item', label: 'Open Link in New Tab', action: 'open-link-tab', icon: 'external', data: { url: ctx.linkURL } });
    items.push({ type: 'item', label: 'Copy Link Address', action: 'copy-link', icon: 'link', data: { url: ctx.linkURL } });
    items.push({ type: 'separator' });
  }

  // Image
  if (ctx.mediaType === 'image') {
    items.push({ type: 'item', label: 'Open Image in New Tab', action: 'open-link-tab', icon: 'image', data: { url: ctx.srcURL } });
    items.push({ type: 'item', label: 'Copy Image', action: 'copy-image', icon: 'copy', data: { x: ctx.x, y: ctx.y } });
    items.push({ type: 'item', label: 'Copy Image Address', action: 'copy-image-address', icon: 'link', data: { url: ctx.srcURL } });
    items.push({ type: 'item', label: 'Save Image As\u2026', action: 'save-image', icon: 'download', data: { srcURL: ctx.srcURL } });
    items.push({ type: 'separator' });
  }

  // Editable
  if (ctx.isEditable) {
    items.push({ type: 'item', label: 'Undo', action: 'undo', icon: 'undo', shortcut: '\u2318Z' });
    items.push({ type: 'item', label: 'Redo', action: 'redo', icon: 'redo', shortcut: '\u2318\u21E7Z' });
    items.push({ type: 'separator' });
  }

  // Clipboard
  if (ctx.selectionText && ctx.isEditable) {
    items.push({ type: 'item', label: 'Cut', action: 'cut', icon: 'scissors', shortcut: '\u2318X' });
  }
  if (ctx.selectionText) {
    items.push({ type: 'item', label: 'Copy', action: 'copy', icon: 'copy', shortcut: '\u2318C' });
  }
  if (ctx.isEditable) {
    items.push({ type: 'item', label: 'Paste', action: 'paste', icon: 'clipboard', shortcut: '\u2318V' });
  }
  items.push({ type: 'item', label: 'Select All', action: 'select-all', icon: 'select-all', shortcut: '\u2318A' });
  items.push({ type: 'separator' });

  // AI section
  items.push({ type: 'header', label: 'Sulla AI' });
  if (ctx.selectionText) {
    items.push({ type: 'item', label: 'Ask Sulla about this', action: 'ai-ask', icon: 'chat', data: { text: ctx.selectionText } });
  }
  if (ctx.selectionText && ctx.selectionText.length > 100) {
    items.push({ type: 'item', label: 'Summarize', action: 'ai-summarize', icon: 'document', data: { text: ctx.selectionText } });
  }
  if (ctx.selectionText) {
    items.push({ type: 'item', label: 'Translate\u2026', action: 'ai-translate', icon: 'globe', data: { text: ctx.selectionText }, cssClass: 'has-submenu' });
  }
  items.push({ type: 'item', label: 'Explain this page', action: 'ai-explain-page', icon: 'book' });
  items.push({ type: 'item', label: 'Screenshot & Analyze', action: 'ai-screenshot', icon: 'camera' });
  items.push({ type: 'separator' });

  // Page
  items.push({ type: 'item', label: 'View Page Source', action: 'view-source', icon: 'code' });
  items.push({ type: 'item', label: 'Inspect Element', action: 'inspect', icon: 'inspect', data: { x: ctx.x, y: ctx.y } });

  return items;
}

// ---------------------------------------------------------------------------
// Injected runtime — this string runs inside the WebContentsView page
// ---------------------------------------------------------------------------

const MENU_RUNTIME = `
var __sullaCtxMenu = function(items, ctx) {
  // Remove any existing menu
  var existing = document.querySelector('sulla-context-menu');
  if (existing) existing.remove();

  // Register custom element once
  if (!customElements.get('sulla-context-menu')) {
    customElements.define('sulla-context-menu', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'open' }); }
    });
  }

  var el = document.createElement('sulla-context-menu');
  document.body.appendChild(el);
  var shadow = el.shadowRoot;

  // --- Styles ---
  var style = document.createElement('style');
  style.textContent = \`
    :host {
      position: fixed;
      z-index: 2147483647;
      top: 0; left: 0; width: 100vw; height: 100vh;
      pointer-events: auto;
      -webkit-user-select: none;
      user-select: none;
    }
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 0;
    }
    .menu {
      position: fixed;
      z-index: 1;
      min-width: 220px;
      max-width: 320px;
      max-height: 80vh;
      overflow-y: auto;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.6), 0 0 1px rgba(63,185,80,0.15);
      padding: 6px 0;
      animation: ctxFade 0.15s ease-out;
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
      font-size: 13px;
      color: #c9d1d9;
    }
    @keyframes ctxFade {
      from { opacity: 0; transform: scale(0.96); }
      to   { opacity: 1; transform: scale(1); }
    }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 14px;
      border: none;
      background: transparent;
      color: #c9d1d9;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
      transition: background 0.1s;
      line-height: 1.2;
    }
    .item:hover:not(.disabled) {
      background: #21262d;
      color: #3fb950;
    }
    .item:hover:not(.disabled) svg {
      stroke: #3fb950;
    }
    .item.disabled {
      opacity: 0.4;
      cursor: default;
    }
    .item.spelling {
      font-weight: 600;
      color: #3fb950;
    }
    .shortcut {
      margin-left: auto;
      font-size: 11px;
      color: #484f58;
      padding-left: 16px;
    }
    .sep {
      height: 1px;
      background: #30363d;
      margin: 4px 0;
    }
    .header {
      padding: 8px 14px 4px;
      font-weight: 600;
      font-size: 11px;
      color: #484f58;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .item.has-submenu::after {
      content: '\u25B8';
      margin-left: auto;
      font-size: 10px;
      color: #484f58;
    }
    .submenu {
      position: fixed;
      min-width: 160px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.6);
      padding: 6px 0;
      font-family: inherit;
      font-size: 13px;
      color: #c9d1d9;
      z-index: 2;
      animation: ctxFade 0.1s ease-out;
    }
    .menu::-webkit-scrollbar { width: 6px; }
    .menu::-webkit-scrollbar-track { background: transparent; }
    .menu::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
    svg { flex-shrink: 0; }
  \`;
  shadow.appendChild(style);

  // --- Overlay (click-outside dismiss) ---
  var overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.addEventListener('click', function() { el.remove(); });
  overlay.addEventListener('contextmenu', function(e) { e.preventDefault(); el.remove(); });
  shadow.appendChild(overlay);

  // --- Icons ---
  var ICONS = {
    'chevron-left':  '<path d="M15 18l-6-6 6-6"/>',
    'chevron-right': '<path d="M9 18l6-6-6-6"/>',
    'reload':        '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
    'external':      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    'link':          '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'image':         '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    'copy':          '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'download':      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    'undo':          '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    'redo':          '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    'scissors':      '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
    'clipboard':     '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
    'select-all':    '<path d="M3 3h18v18H3z"/><path d="M8 8h8v8H8z"/>',
    'plus':          '<path d="M12 5v14M5 12h14"/>',
    'chat':          '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v2"/><path d="M12 13h.01"/>',
    'document':      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    'globe':         '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    'book':          '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    'camera':        '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    'code':          '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    'inspect':       '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  };

  function icon(name) {
    var svg = ICONS[name];
    if (!svg) return '';
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + svg + '</svg>';
  }

  // --- Translate submenu ---
  var LANGUAGES = [
    { code: 'Spanish',    flag: '\\ud83c\\uddea\\ud83c\\uddf8' },
    { code: 'French',     flag: '\\ud83c\\uddeb\\ud83c\\uddf7' },
    { code: 'German',     flag: '\\ud83c\\udde9\\ud83c\\uddea' },
    { code: 'Japanese',   flag: '\\ud83c\\uddef\\ud83c\\uddf5' },
    { code: 'Chinese',    flag: '\\ud83c\\udde8\\ud83c\\uddf3' },
    { code: 'Portuguese', flag: '\\ud83c\\udde7\\ud83c\\uddf7' },
  ];

  function showTranslateSubmenu(btn, text) {
    // Remove any existing submenu
    var old = shadow.querySelector('.submenu');
    if (old) old.remove();

    var sub = document.createElement('div');
    sub.className = 'submenu';

    LANGUAGES.forEach(function(lang) {
      var b = document.createElement('button');
      b.className = 'item';
      b.innerHTML = '<span style="font-size:14px;line-height:1">' + lang.flag + '</span> <span>' + lang.code + '</span>';
      b.addEventListener('click', function() {
        emit('ai-translate', { text: text, lang: lang.code });
        el.remove();
      });
      sub.appendChild(b);
    });

    shadow.appendChild(sub);

    // Position next to the button
    var btnRect = btn.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    sub.style.position = 'fixed';
    sub.style.top = btnRect.top + 'px';
    sub.style.left = (btnRect.right + 4) + 'px';

    // Clamp
    requestAnimationFrame(function() {
      var sr = sub.getBoundingClientRect();
      if (sr.right > vw) sub.style.left = (btnRect.left - sr.width - 4) + 'px';
      if (sr.bottom > vh) sub.style.top = Math.max(4, vh - sr.height - 4) + 'px';
    });
  }

  // --- Emit helper ---
  function emit(action, data) {
    var payload = Object.assign({ action: action }, data || {});
    if (typeof window.__sullaBridgeEmit === 'function') {
      window.__sullaBridgeEmit('context-menu-action', payload);
    }
  }

  // --- Build menu DOM ---
  var menu = document.createElement('div');
  menu.className = 'menu';

  items.forEach(function(item) {
    if (item.type === 'separator') {
      var sep = document.createElement('div');
      sep.className = 'sep';
      menu.appendChild(sep);
      return;
    }
    if (item.type === 'header') {
      var hdr = document.createElement('div');
      hdr.className = 'header';
      hdr.textContent = item.label;
      menu.appendChild(hdr);
      return;
    }

    var btn = document.createElement('button');
    btn.className = 'item' + (item.disabled ? ' disabled' : '') + (item.cssClass ? ' ' + item.cssClass : '');
    if (item.disabled) btn.disabled = true;

    var html = '';
    if (item.icon) html += icon(item.icon);
    html += '<span>' + (item.label || '') + '</span>';
    if (item.shortcut) html += '<span class="shortcut">' + item.shortcut + '</span>';
    btn.innerHTML = html;

    if (!item.disabled) {
      btn.addEventListener('click', function(e) {
        if (item.action === 'ai-translate') {
          e.stopPropagation();
          showTranslateSubmenu(btn, item.data && item.data.text);
          return;
        }
        emit(item.action, item.data);
        el.remove();
      });
    }

    menu.appendChild(btn);
  });

  // --- Position: render hidden, measure, clamp, then reveal ---
  menu.style.visibility = 'hidden';
  menu.style.left = ctx.x + 'px';
  menu.style.top = ctx.y + 'px';
  shadow.appendChild(menu);

  // Force layout so we can measure the menu dimensions
  var rect = menu.getBoundingClientRect();
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var finalX = ctx.x;
  var finalY = ctx.y;
  if (rect.right > vw) finalX = Math.max(4, vw - rect.width - 4);
  if (rect.bottom > vh) finalY = Math.max(4, vh - rect.height - 4);
  menu.style.left = finalX + 'px';
  menu.style.top = finalY + 'px';
  menu.style.visibility = '';

  // --- Escape to close ---
  function onKey(e) {
    if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', onKey, true); }
  }
  document.addEventListener('keydown', onKey, true);

  // Cleanup listener when element is removed
  var obs = new MutationObserver(function() {
    if (!document.contains(el)) {
      document.removeEventListener('keydown', onKey, true);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true });
};
`;
