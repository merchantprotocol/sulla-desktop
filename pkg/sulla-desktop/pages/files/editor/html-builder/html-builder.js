/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Origin: pkg/sulla-desktop/pages/files/editor/html-builder/html-builder.js
 * Cloud copy is vendored; edit only in sulla-desktop.
 */
(function(root) {
  'use strict';
  const VERSION = '1.2.0';
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
    'track', 'wbr'
  ]);
  const RAW = new Set(['script', 'style']);
  const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  function scanTagEnd(source, start) {
    let quote = '';
    for (let i = start; i < source.length; i += 1) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = '';
        else if (c === '\\') i += 1;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') return i + 1;
    }
    return source.length;
  }

  function tokenize(source) {
    const roots = [];
    const all = [];
    const stack = [];
    const diagnostics = [];
    const seenIds = new Map();
    let i = 0;
    const attach = node => {
      const parent = stack.at(-1);
      node.parent = parent || null;
      (parent ? parent.children : roots).push(node);
      all.push(node);
    };
    while (i < source.length) {
      const lt = source.indexOf('<', i);
      if (lt < 0) break;
      i = lt;
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', i)) {
        const end = source.indexOf(']]>', i + 9);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
        i = scanTagEnd(source, i + 2);
        continue;
      }
      const close = /^<\s*\/\s*([A-Za-z][\w:-]*)/.exec(source.slice(i));
      if (close) {
        const end = scanTagEnd(source, i + close[0].length);
        const name = close[1].toLowerCase();
        let at = stack.length - 1;
        while (at >= 0 && stack[at].name !== name) at -= 1;
        if (at < 0) {
          diagnostics.push({ type: 'stray-closing-tag', message: `Stray closing tag </${name}>`, start: i, end });
        } else {
          if (at !== stack.length - 1) {
            const expected = stack.at(-1).name;
            diagnostics.push({ type: 'mismatched-closing-tag', message: `Expected </${expected}> before </${name}>`, start: i, end });
            for (let n = stack.length - 1; n > at; n -= 1) {
              diagnostics.push({ type: 'unclosed-tag', message: `Unclosed <${stack[n].name}> tag`, start: stack[n].start, end: stack[n].openEnd });
            }
          }
          const node = stack[at];
          node.closeStart = i;
          node.end = end;
          stack.length = at;
        }
        i = end;
        continue;
      }
      const open = /^<\s*([A-Za-z][\w:-]*)/.exec(source.slice(i));
      if (!open) {
        i += 1;
        continue;
      }
      const end = scanTagEnd(source, i + open[0].length);
      const name = open[1].toLowerCase();
      const node = {
        name,
        start: i,
        openEnd: end,
        closeStart: end,
        end,
        children: [],
        parent: null
      };
      attach(node);
      const openText = source.slice(i, end);
      const ids = [...openText.matchAll(/\bid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi)];
      if (ids.length > 1) diagnostics.push({ type: 'duplicate-id-attribute', message: `<${name}> has duplicate id attributes`, start: i, end });
      for (const id of ids) {
        const value = id[0].replace(/^\s*id\s*=\s*/i, '').replace(/^(["'])(.*)\1$/, '$2');
        if (value && seenIds.has(value)) diagnostics.push({
          type: 'duplicate-id', message: `Duplicate id="${value}"`, start: i, end
        });
        else if (value) seenIds.set(value, i)
      }
      if (name === 'img' && !/\balt\s*=/i.test(openText)) diagnostics.push({ type: 'img-missing-alt', message: '<img> is missing an alt attribute', start: i, end });
      if (!VOID.has(name) && !/\/\s*>$/.test(openText)) {
        stack.push(node);
        if (RAW.has(name)) {
          const re = new RegExp('<\\s*\\/\\s*' + name + '\\s*>', 'ig');
          re.lastIndex = end;
          const match = re.exec(source);
          if (match) {
            node.closeStart = match.index;
            node.end = re.lastIndex;
            stack.pop();
            i = re.lastIndex;
            continue;
          }
        }
      }
      i = end;
    }
    for (const node of stack) {
      node.closeStart = source.length;
      node.end = source.length;
      diagnostics.push({ type: 'unclosed-tag', message: `Unclosed <${node.name}> tag`, start: node.start, end: node.openEnd });
    }
    return {
      roots,
      all,
      diagnostics
    };
  }

  function injectDocument(source, run, base) {
    let value = source;
    if (base) {
      const tag = `<base href="${escapeAttribute(base)}">`;
      const head = /<head(?:\s[^>]*)?>/i.exec(value);
      value = head ? value.slice(0, head.index + head[0].length) + tag + value.slice(head.index + head[0].length) :
        tag + value;
    }
    // Run mode needs no extra meta: the sandbox (no allow-top-navigation, no
    // allow-same-origin) is what keeps the page away from the app.
    return value;
  }

  function patchSource(source, from, to, replacement) {
    return source.slice(0, from) + replacement + source.slice(to);
  }

  function sandboxFor(run) {
    return run ? 'allow-scripts allow-forms allow-popups allow-modals' : 'allow-same-origin';
  }

  // Which frame policy to use. Hosts with a strict CSP (Sulla Cloud's vault
  // origin) pass canRunScripts: false, so "editing off" is a read-only,
  // script-free preview instead of a run mode that would silently do nothing.
  function previewPolicy(editing, canRunScripts) {
    const run = !editing && canRunScripts !== false;
    return { run, sandbox: sandboxFor(run) };
  }

  // Strict-CSP hosts (style-src without 'unsafe-inline') block <style> and
  // style="" inside srcdoc frames. CSSOM is not governed by style-src, so
  // re-apply the page's own styles through constructed sheets and
  // element.style. Only used for same-origin (non-run) frames.
  function applyCssomStyles(d) {
    const win = d && d.defaultView;
    if (!win || typeof win.CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in d)) return;
    const sheets = [];
    d.querySelectorAll('style').forEach(node => {
      try {
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(node.textContent || '');
        sheets.push(sheet);
      } catch (_) {
        // A sheet the browser can't parse is skipped, same as in a normal page.
      }
    });
    d.adoptedStyleSheets = sheets;
    d.querySelectorAll('[style]').forEach(el => {
      el.style.cssText = el.getAttribute('style') || '';
    });
  }

  function mount(host, options = {}) {
    if (!host || host.nodeType !== 1) throw new TypeError('SullaHtmlBuilder.mount needs a host element');
    const fileName = () => options.fileName || 'untitled.html';
    host.innerHTML = `<div class="shb-root v-builder" tabindex="0">
<div class="shb-wb-hot" id="hot"></div>
<header class="shb-wb-bar" id="bar">
  ${options.onBack ? '<button class="shb-wb-back" id="back" title="Back to Files"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>Files</button>' : ''}
  ${options.onRename ? '<input class="shb-wb-name" id="fname" value="" title="Click to rename">' : '<span class="shb-wb-name shb-wb-name-static" id="fname"></span>'}
  <span class="shb-wb-save" id="save"><i></i><span>Saved</span></span>
  <nav class="shb-wb-menus" id="menus"></nav>
  <div class="shb-wb-sp"></div>
  <button class="shb-wb-tog on" id="editTog" title="Turn editing off to run the page like a browser (E)"><span class="sw"></span><span id="editLbl">Editing</span></button>
  <div class="shb-wb-div"></div>
  <div class="shb-wb-seg" id="views"><button data-v="builder" class="on" title="Builder: the page only">Builder</button><button data-v="workbench" title="Workbench: page and source side by side">Workbench</button></div>
  <button class="shb-wb-ib" id="bSource" title="Source code (⌘U)"><svg viewBox="0 0 24 24"><path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 5l-3 14"/></svg></button>
  <div class="shb-wb-div"></div>
  <div class="shb-wb-seg sm">
    <button data-w="100%" class="dev on" title="Desktop"><svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>
    <button data-w="768px" class="dev" title="Tablet"><svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/></svg></button>
    <button data-w="390px" class="dev" title="Phone"><svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg></button>
  </div>
  <div class="shb-wb-div"></div>
  <button class="shb-wb-ib" id="bUndo" title="Undo (⌘Z)"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
  <button class="shb-wb-ib" id="bRedo" title="Redo (⇧⌘Z)"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button>
  ${options.onHistory ? '<button class="shb-wb-ib" id="bHist" title="History"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg></button>' : ''}
  <div class="shb-wb-pres"></div>
  <button class="shb-wb-ib" id="bFocus" title="Focus mode (F)"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
</header>
<div class="shb-wb-drop" id="drop"></div>

<div class="shb-dv-work" id="work">
  <aside class="shb-wb-fly" id="fly"><div class="shb-wb-flyh">LAYERS<span class="shb-wb-sp"></span><button class="shb-wb-ib" id="flyX" title="Close (Esc)">×</button></div><div class="shb-wb-tree" id="tree"></div></aside>
  <section class="shb-dv-code" id="code">
    <div class="shb-dv-ch"><svg viewBox="0 0 24 24"><path d="M8 9l-4 3 4 3M16 9l4 3-4 3"/></svg><span id="codeTitle">Source</span><button id="codeX" title="Hide source">×</button></div>
    <div class="shb-dv-scroll" id="scroll"><div class="shb-dv-cw"><div class="shb-dv-gut" id="gut"></div><div class="shb-dv-ed"><div class="shb-dv-band" id="band" style="display:none"></div><pre class="shb-dv-hl" id="hl"></pre><textarea class="shb-dv-ta" id="ta" spellcheck="false"></textarea></div></div></div>
  </section>
  <div class="shb-wb-drag" id="drag"></div>
  <div class="shb-dv-stage" id="stage">
    <div class="shb-wb-chrome">
      <button class="shb-wb-ib" disabled title="Back"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
      <button class="shb-wb-ib" disabled title="Forward"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="shb-wb-ib" id="pReload" title="Reload (⌘R)"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>
      <div class="shb-wb-url"><svg viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span id="pUrl"></span><span class="shb-wb-sp"></span><b>Scripts running · sandboxed</b></div>
      ${options.onOpenInBrowser ? '<button class="shb-wb-ib" id="pOpen" title="Open in a Sulla browser tab"><svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button>' : ''}
    </div>
    <iframe class="shb-dv-frame" id="frame" title="Page"></iframe>
    <div class="shb-dv-wire" id="wire"></div>
    <div class="shb-wb-pickbar">Click anything on the page to inspect it · Esc to cancel</div>
    <div class="shb-wb-probs" id="probs"></div>
  </div>
</div>

<div class="shb-dv-layer" id="layer">
  <div class="shb-dv-ol sec" id="olSec"></div><div class="shb-dv-ol row" id="olRow"></div><div class="shb-dv-ol mod" id="olMod"></div>
  <div class="shb-dv-tb sec" id="tbSec"></div><div class="shb-dv-tb row" id="tbRow"></div><div class="shb-dv-tb mod" id="tbMod"></div>
  <button class="shb-dv-plus sec" id="plusSec" title="Add section below"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
  <button class="shb-dv-plus mod" id="plusMod" title="Add module below"><svg viewBox="0 0 24 24" style="width:13px;height:13px"><path d="M12 5v14M5 12h14"/></svg></button>
</div>
<div class="shb-dv-modal" id="modal">
  <div class="shb-dv-mh" id="mh"><b><span id="mTitle">Settings</span><span class="shb-dv-mcrumb" id="mCrumb"></span></b>
    <button id="mDock" title="Dock to the side"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
    <button id="mX" title="Close">×</button></div>
  <div class="shb-dv-tabs" id="mTabs"><button data-t="content" class="on">Content</button><button data-t="design">Design</button><button data-t="advanced">Advanced</button></div>
  <div class="shb-dv-msearch"><input id="mFind" placeholder="Search settings… (e.g. padding, colour)"></div>
  <div class="shb-dv-mb" id="mBody"></div>
  <div class="shb-dv-mf"><button class="x" id="fX" title="Discard changes"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button><button class="u" id="fU" title="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button><button class="re" id="fR" title="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg></button><button class="ok" id="fOk" title="Keep changes"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></button></div>
</div>

<div class="shb-dv-dim" id="dim"></div>
<div class="shb-dv-lib" id="lib"><div class="shb-dv-lh"><b id="libTitle">Add a section</b><button id="libX">×</button></div><div class="shb-dv-lg" id="libGrid"></div></div>
<div class="shb-dv-ctx" id="ctx"></div>
<div class="shb-dv-hist" id="hist"></div>
<div class="shb-dv-toast" id="toast"></div>

<div class="shb-dv-lib shb-wb-dlg" id="dlg"><div class="shb-dv-lh"><b id="dlgTitle"></b><button id="dlgX">×</button></div><div id="dlgBody" style="overflow:auto"></div></div>

</div>`;
    const rootEl = host.querySelector('.shb-root');
    let externalSourceEditor = null;
    const $ = id => host.querySelector(`#${id}`);
    const frame = $('frame');
    let src = String(options.source ?? '');
    let hov = null;
    let sel = null;
    let runKeep = 0;
    let styleClip = null;
    let modalSnap = null;
    const undo = [],
      redo = [];
    const VOID = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source']);
    const INLINE = /^(strong|em|b|i|a|br|span|small|code)$/;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const doc = () => frame.contentDocument;
    // ---------- source mapping ----------
    function keyOf(el) {
      const tag = el.tagName.toLowerCase();
      return {
        tag,
        i: [...doc().getElementsByTagName(tag)].indexOf(el)
      };
    }

    function elOf(key) {
      return key && doc()?.getElementsByTagName(key.tag)[key.i];
    }

    function locate(key) {
      if (!key) return null;
      const matches = tokenize(src).all.filter(node => node.name === key.tag);
      const node = matches[key.i];
      if (!node) return null;
      return {
        start: node.start,
        openEnd: node.openEnd,
        close: node.closeStart,
        end: node.end,
        editable: node.closeStart > node.openEnd &&
          !/<(?!\/?(strong|em|b|i|a|br|span|small|code)\b)[a-z]/i.test(src.slice(node.openEnd, node.closeStart)),
      };
    }
    const lineAt = index => src.slice(0, index).split('\n').length;
    // ---------- hierarchy ----------
    const kind = el => {
      if (!el || el === doc().body) return null;
      if (el.parentElement === doc().body) return 'sec';
      const kids = [...el.children].filter(c => !INLINE.test(c.tagName.toLowerCase()));
      return kids.length ? 'row' : 'mod'
    };

    function chain(t) {
      let mod = null,
        row = null,
        sec = null,
        e = t;
      while (e && e !== doc().body) {
        const k = kind(e);
        if (k === 'mod' && !mod && !row) mod = e;
        else if (k === 'row' && !row) row = e;
        else if (k === 'sec') sec = e;
        e = e.parentElement
      }
      return {
        mod,
        row,
        sec
      }
    }
    const NAMES = {
      h1: 'Heading',
      h2: 'Heading',
      h3: 'Heading',
      h4: 'Heading',
      p: 'Text',
      a: 'Link',
      img: 'Image',
      hr: 'Divider',
      blockquote: 'Quote',
      details: 'Toggle',
      summary: 'Toggle title',
      strong: 'Text',
      button: 'Button',
      ul: 'List',
      li: 'List item',
      header: 'Header',
      footer: 'Footer',
      nav: 'Menu'
    };

    function label(el) {
      const t = el.tagName.toLowerCase(),
        c = typeof el.className === 'string' && el.className.trim().split(' ')[0];
      if (t === 'a' && c === 'cta') return 'Button';
      if (kind(el) === 'sec') return NAMES[t] || ('Section' + (c ? ' · ' + c : ''));
      if (kind(el) === 'row') return c ? ('Row · ' + c) : 'Row';
      return NAMES[t] || t
    }
    // ---------- render ----------
    let editing = true;
    const LINKCATCH =
      "<script>document.addEventListener('click',function(e){var a=e.target.closest('a');if(!a)return;var h=a.getAttribute('href')||'';if(/^https?:/.test(h)){a.target='_blank';return}if(e.defaultPrevented)return;e.preventDefault();parent.postMessage({sullaPreviewLink:h},'*')});<\/script>";

    function render() {
      try {
        runKeep = frame.contentWindow?.scrollY || 0;
      } catch (_) {
        runKeep = 0;
      }
      const policy = previewPolicy(editing, options.canRunScripts);
      frame.setAttribute('sandbox', policy.sandbox);
      frame.srcdoc = injectDocument(src, policy.run, options.assetBaseUrl);
      const badge = host.querySelector('.shb-wb-url b');
      if (badge) badge.textContent = policy.run ? 'Scripts running · sandboxed' : 'Preview · scripts don’t run here';
    }
    addEventListener('message', e => {
      if (e.data && e.data.sullaPreviewLink != null) {
        const h = e.data.sullaPreviewLink;
        toast(h === '#' || !h ? 'Link intercepted: href="#" goes nowhere' : 'Link intercepted: ' + h +
          ' is not a file in this folder')
      }
    });

    function setEditing(on) {
      on = Boolean(on && !options.readOnly);
      editing = on;
      rootEl.classList.toggle('preview', !on);
      $('editTog').classList.toggle('on', on);
      $('editLbl').textContent = on ? 'Editing' : 'Editing off';
      if (!on) {
        if ($('modal').classList.contains('on')) closeModal(true);
        closeLib();
        hideCtx();
        stopPick();
        hov = null;
        sel = null;
        draw();
        $('probs').classList.remove('on')
      }
      $('ta').readOnly = !on;
      [...$('menus').children].forEach(b => b.classList.toggle('lock', !on && LOCKED.includes(b.dataset.m)));
      render();
      localStorage.setItem('sulla.htmlEditor.editing', on ? '1' : '0');
      toast(on ? 'Editing on · scripts paused while you edit' :
        options.canRunScripts === false ? 'Editing off · read-only preview, scripts don’t run here' :
        'Editing off · the page runs like a browser, scripts on')
    }
    const LOCKED = ['Edit', 'Insert', 'Format', 'Inspect'];
    $('editTog').onclick = () => setEditing(!editing);
    $('pReload').onclick = () => {
      render();
      toast('Reloaded')
    };
    if ($('pOpen')) $('pOpen').onclick = () => options.onOpenInBrowser();
    frame.addEventListener('load', () => {
      const run = previewPolicy(editing, options.canRunScripts).run;
      if (!run && options.styleMode === 'cssom') applyCssomStyles(doc());
      if (!editing) return;
      const d = doc();
      if (runKeep) frame.contentWindow.scrollTo(0, runKeep);
      d.addEventListener('mouseover', e => {
        if (e.target === d.body || e.target === d.documentElement) return;
        hov = e.target;
        clearTimeout(hideT);
        draw()
      });
      d.addEventListener('mouseleave', () => {
        hideT = setTimeout(() => {
          hov = null;
          draw()
        }, 350)
      });
      d.addEventListener('click', e => {
        const el = e.target;
        e.preventDefault();
        hideCtx();
        closeMenu();
        if (picking) {
          pickDone(el);
          return
        }
        lastPick = el;
        if (el.isContentEditable) return;
        const k = kind(el);
        if (k === 'mod' && locate(keyOf(el))?.editable && el.textContent.trim()) inline(el);
        else openSettings(el)
      }, true);
      d.addEventListener('contextmenu', e => {
        e.preventDefault();
        openCtx(e.target, e.clientX + frame.getBoundingClientRect().left, e.clientY + frame
          .getBoundingClientRect().top)
      });
      d.addEventListener('scroll', draw);
      d.addEventListener('keydown', keys);
      if (sel && !elOf(sel)) sel = null;
      draw();
      if ($('wire').classList.contains('on')) buildWire()
    });
    let hideT;
    ['tbSec', 'tbRow', 'tbMod', 'plusSec', 'plusMod'].forEach(id => {
      $(id).onmouseenter = () => clearTimeout(hideT);
      $(id).onmouseleave = () => {
        hideT = setTimeout(() => {
          hov = null;
          draw()
        }, 350)
      }
    });

    function rectOf(el) {
      const f = frame.getBoundingClientRect(),
        r = el.getBoundingClientRect();
      return {
        l: f.left + r.left,
        t: f.top + r.top,
        w: r.width,
        h: r.height
      }
    }

    function place(o, r) {
      o.style.left = r.l + 'px';
      o.style.top = r.t + 'px';
      o.style.width = r.w + 'px';
      o.style.height = r.h + 'px'
    }

    function tb(id, el, where) {
      const box = $(id),
        r = rectOf(el),
        k = kind(el);
      box.innerHTML = `<span>${label(el)}</span>` + [
        ['up', 'Move up', 'M12 19V5M5 12l7-7 7 7'],
        ['down', 'Move down', 'M12 5v14M19 12l-7 7-7-7'],
        ['gear', 'Settings',
          'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'
        ],
        ['dup', 'Duplicate', 'M8 8h12v12H8zM4 16V4h12'],
        ['ai', 'Ask Sulla',
          'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'
        ],
        ['del', 'Delete', 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3']
      ].filter(([a]) => a !== 'ai' || options.onAskSulla).map(([a, t, p]) =>
        `<button data-a="${a}" title="${t}"><svg viewBox="0 0 24 24"><path d="${p}"/></svg></button>`).join('');
      box.querySelectorAll('button').forEach(b => b.onclick = ev => {
        ev.stopPropagation();
        act(b.dataset.a, el)
      });
      box.style.display = 'block';
      const w = box.offsetWidth;
      let x = where === 'right' ? r.l + r.w - w : r.l,
        y = r.t - (k === 'sec' ? 0 : 0);
      if (k === 'sec') y = Math.max(r.t, 0);
      box.style.left = Math.max(4, x) + 'px';
      box.style.top = Math.max(4, y) + 'px'
    }

    function draw() {
      ['olSec', 'olRow', 'olMod', 'tbSec', 'tbRow', 'tbMod', 'plusSec', 'plusMod'].forEach(i => {
        $(i).style.display = 'none';
        $(i).classList.remove('sel')
      });
      const s = elOf(sel);
      if (s && $('modal').classList.contains('on')) {
        const o = $({
          sec: 'olSec',
          row: 'olRow',
          mod: 'olMod'
        } [kind(s)]);
        place(o, rectOf(s));
        o.style.display = 'block';
        o.classList.add('sel')
      }
      if (!hov || !doc()?.contains(hov) || $('wire').classList.contains('on')) return;
      const c = chain(hov);
      if (c.sec) {
        const r = rectOf(c.sec);
        place($('olSec'), r);
        $('olSec').style.display = 'block';
        tb('tbSec', c.sec, 'left');
        const p = $('plusSec');
        p.style.left = (r.l + r.w / 2) + 'px';
        p.style.top = (r.t + r.h) + 'px';
        p.style.display = 'grid'
      }
      if (c.row) {
        place($('olRow'), rectOf(c.row));
        $('olRow').style.display = 'block';
        tb('tbRow', c.row, 'left');
        const r = rectOf(c.row);
        $('tbRow').style.top = (r.t + 2) + 'px';
        $('tbRow').style.left = (r.l + 2) + 'px'
      }
      if (c.mod) {
        const r = rectOf(c.mod);
        place($('olMod'), r);
        $('olMod').style.display = 'block';
        tb('tbMod', c.mod, 'right');
        $('tbMod').style.top = Math.max(4, r.t - 27) + 'px';
        const p = $('plusMod');
        p.style.left = (r.l + r.w / 2) + 'px';
        p.style.top = (r.t + r.h + 2) + 'px';
        p.style.display = 'grid'
      }
    }
    $('plusSec').onclick = () => openLib('sec', chain(hov).sec);
    $('plusMod').onclick = () => openLib('mod', chain(hov).mod);
    // ---------- edits ----------
    let nextLabel = 'Edit';

    function setSrc(v, {
      reload = true,
      merge = false,
      label = nextLabel
    } = {}) {
      if (v === src) return;
      nextLabel = 'Edit';
      const last = undo.at(-1);
      if (!merge || !last || Date.now() - last.t > 900 || last.label !== label) undo.push({
        s: src,
        t: Date.now(),
        label,
        at: new Date()
      });
      redo.length = 0;
      src = v;
      afterChange(reload)
    }

    function afterChange(reload) {
      $('ta').value = src;
      if (externalSourceEditor && externalSourceEditor.getValue() !== src) externalSourceEditor.setValue(src);
      renderCode();
      dirty();
      options.onChange?.(src);
      if (reload) {
        clearTimeout(afterChange.t);
        afterChange.t = setTimeout(render, 60)
      }
    }

    function doUndo() {
      const u = undo.pop();
      if (!u) {
        toast('Nothing to undo');
        return
      }
      redo.push({
        s: src,
        label: u.label,
        at: u.at
      });
      src = u.s;
      afterChange(true);
      if ($('modal').classList.contains('on')) setTimeout(fillModal, 120)
    }

    function doRedo() {
      const r = redo.pop();
      if (!r) return;
      undo.push({
        s: src,
        t: 0,
        label: r.label,
        at: r.at
      });
      src = r.s;
      afterChange(true);
      if ($('modal').classList.contains('on')) setTimeout(fillModal, 120)
    }

    function act(a, el) {
      const k = keyOf(el),
        r = locate(k);
      if (!r) return;
      if (a === 'gear') openSettings(el);
      if (a === 'ai') {
        openSettings(el);
        setTimeout(() => $('askIn')?.focus(), 50)
      }
      nextLabel = ({
        dup: 'Duplicated ',
        del: 'Deleted ',
        up: 'Moved up ',
        down: 'Moved down '
      } [a] || '') + label(el);
      if (a === 'dup') {
        const ind = indentAt(r.start);
        setSrc(src.slice(0, r.end) + '\n' + ind + src.slice(r.start, r.end) + src.slice(r.end));
        toast(label(el) + ' duplicated', true)
      }
      if (a === 'del') {
        let s = r.start;
        const ls = src.lastIndexOf('\n', s - 1);
        if (/^\s*$/.test(src.slice(ls + 1, s))) s = ls;
        setSrc(src.slice(0, s) + src.slice(r.end));
        hov = null;
        if (sel && sel.tag === k.tag && sel.i === k.i) closeModal(true);
        toast(label(el) + ' deleted', true)
      }
      if (a === 'up' || a === 'down') {
        const sib = a === 'up' ? el.previousElementSibling : el.nextElementSibling;
        if (!sib || ['STYLE', 'SCRIPT'].includes(sib.tagName)) {
          toast('Already at the ' + (a === 'up' ? 'top' : 'bottom'));
          return
        }
        const [A, B] = a === 'up' ? [sib, el] : [el, sib];
        swap(A, B);
        hov = null;
        toast('Moved ' + a, true)
      }
    }

    function swap(A, B) {
      const ra = locate(keyOf(A)),
        rb = locate(keyOf(B));
      setSrc(src.slice(0, ra.start) + src.slice(rb.start, rb.end) + src.slice(ra.end, rb.start) + src.slice(ra.start,
        ra.end) + src.slice(rb.end))
    }
    const indentAt = i => src.slice(src.lastIndexOf('\n', i - 1) + 1, i).match(/^\s*/)[0];

    function getAttr(k, n) {
      const r = locate(k);
      const m = src.slice(r.start, r.openEnd).match(new RegExp('\\s' + n + '="([^"]*)"'));
      return m ? m[1] : null
    }

    function setAttr(k, n, v, opts) {
      const r = locate(k);
      let open = src.slice(r.start, r.openEnd);
      const re = new RegExp('\\s' + n + '="[^"]*"');
      if (v === '' || v == null) open = open.replace(re, '');
      else if (re.test(open)) open = open.replace(re, ` ${n}="${v.replace(/"/g,'&quot;')}"`);
      else open = open.replace(/\s*(\/?>)$/, ` ${n}="${v.replace(/"/g,'&quot;')}"$1`);
      setSrc(src.slice(0, r.start) + open + src.slice(r.openEnd), opts)
    }

    function styleMap(k) {
      const m = {};
      (getAttr(k, 'style') || '').split(';').forEach(d => {
        const i = d.indexOf(':');
        if (i > 0) m[d.slice(0, i).trim()] = d.slice(i + 1).trim()
      });
      return m
    }

    function setStyle(k, prop, val) {
      nextLabel = label(elOf(k)) + ': ' + prop;
      const m = styleMap(k);
      if (val === '' || val == null) delete m[prop];
      else m[prop] = val;
      const s = Object.entries(m).map(([a, b]) => a + ': ' + b).join('; ');
      setAttr(k, 'style', s, {
        reload: false,
        merge: true
      });
      const el = elOf(k);
      if (el) el.style.setProperty(prop, val || '');
      requestAnimationFrame(draw);
      document.querySelectorAll('.shb-dv-f label').forEach(lb => {
        const inp = lb.parentElement.querySelector('input');
        if (inp && PROP[inp.id] === prop) {
          const c = lb.querySelector('.shb-dv-src');
          if (c && !c.classList.contains('own')) {
            c.outerHTML = src_(inp.id);
            wireModal()
          }
        }
      })
    }

    function setText(k, html) {
      nextLabel = label(elOf(k)) + ': text';
      const r = locate(k);
      setSrc(src.slice(0, r.openEnd) + html + src.slice(r.close), {
        reload: false,
        merge: true
      });
      const el = elOf(k);
      if (el) el.innerHTML = html
    }

    function inline(el) {
      const k = keyOf(el);
      el.contentEditable = 'true';
      el.focus();
      hov = el;
      draw();
      el.onblur = () => {
        el.contentEditable = 'false';
        const r = locate(k);
        if (r && src.slice(r.openEnd, r.close) !== el.innerHTML) {
          nextLabel = label(el) + ': text';
          setSrc(src.slice(0, r.openEnd) + el.innerHTML + src.slice(r.close), {
            reload: false
          });
          toast('Text saved · only that line changed', true)
        }
      };
      el.onkeydown = e => {
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
          e.preventDefault();
          el.blur()
        }
      }
    }
    // ---------- settings modal ----------
    let tab = 'content';

    function openSettings(el) {
      sel = keyOf(el);
      modalSnap = src;
      const k = kind(el);
      const m = $('modal');
      $('mh').style.background = `var(--${k})`;
      $('mTitle').textContent = label(el) + ' settings';
      if (!m.classList.contains('on') && !m.classList.contains('docked')) {
        m.style.left = Math.min(innerWidth - 400, rectOf(el).l + rectOf(el).w + 16) + 'px';
        m.style.top = '70px';
        if (parseInt(m.style.left) < 20) m.style.left = '20px'
      }
      const path = [];
      let e = el;
      while (e && e !== doc().body) {
        path.unshift(label(e));
        e = e.parentElement
      }
      $('mCrumb').textContent = path.join(' › ');
      try {
        const P = JSON.parse(localStorage.getItem('sulla.builder.modal') || '{}');
        if (P.docked) m.classList.add('docked');
        else if (P.left != null) {
          m.style.left = Math.min(P.left, innerWidth - 390) + 'px';
          m.style.top = P.top + 'px'
        }
      } catch (_) {}
      m.classList.add('on');
      $('mFind').value = '';
      fillModal();
      draw();
      showBand()
    }
    const saveModalPos = () => {
      const m = $('modal');
      localStorage.setItem('sulla.builder.modal', JSON.stringify({
        docked: m.classList.contains('docked'),
        left: m.offsetLeft,
        top: m.offsetTop
      }))
    };

    function closeModal(keep) {
      if (!keep && modalSnap != null && modalSnap !== src) {
        undo.push({
          s: src,
          t: 0
        });
        src = modalSnap;
        afterChange(true)
      }
      $('modal').classList.remove('on');
      sel = null;
      modalSnap = null;
      draw()
    }
    const grp = (t, body, shut) =>
      `<div class="shb-dv-grp${shut?' shut':''}"><div class="shb-dv-gh">${t}</div><div class="shb-dv-gb">${body}</div></div>`;
    const PROP = {
      dColor: 'color',
      dBg: 'background',
      dSize: 'font-size',
      dPt: 'padding-top',
      dPb: 'padding-bottom',
      dBr: 'border-radius'
    };
    const src_ = id => {
      const p = PROP[id];
      if (!p || !sel) return '';
      return styleMap(sel)[p] != null ?
        `<span class="shb-dv-src own" data-reset="${p}" title="Set on this element. Click to reset to the page style.">this element ×</span>` :
        '<span class="shb-dv-src">from page style</span>'
    };
    const rng = (id, l, v, min, max, u = 'px') =>
      `<div class="shb-dv-f"><label>${l}${src_(id)}</label><div class="shb-dv-rng"><input type="range" id="${id}" min="${min}" max="${max}" value="${v}"><output>${v}${u}</output></div></div>`;
    const clr = (id, l, v) =>
      `<div class="shb-dv-f"><label>${l}${src_(id)}</label><div class="shb-dv-clr"><input type="color" id="${id}" value="${v}"><span>${v}</span><div class="shb-dv-sw">${['#1f2a37','#c2410c','#3a7fa0','#2f8f5b','#fdf6ec','#ffffff'].map(c=>`<i style="background:${c}" data-c="${c}" data-for="${id}"></i>`).join('')}</div></div></div>`;
    const hex = c => {
      const m = c.match(/\d+(\.\d+)?/g);
      if (!m || (m[3] !== undefined && +m[3] === 0)) return '#ffffff';
      return '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join('')
    };

    function fillModal() {
      const el = elOf(sel);
      if (!el) {
        closeModal(true);
        return
      }
      const k = sel,
        r = locate(k),
        cs = frame.contentWindow.getComputedStyle(el),
        t = k.tag;
      let h = '';
      if (tab === 'content') {
        if (options.onAskSulla) h += grp('Ask Sulla',
          `<div class="shb-dv-ask"><input id="askIn" placeholder="e.g. make this punchier"><button id="askGo"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div><div id="propBox"></div>`
          );
        if (r.editable && r.close > -1) h += grp('Text',
          `<div class="shb-dv-f"><textarea id="cText" rows="3">${esc(src.slice(r.openEnd,r.close))}</textarea></div>`
          );
        if (t === 'a') h += grp('Link',
          `<div class="shb-dv-f"><label>Link URL</label><input type="text" id="cHref" value="${esc(getAttr(k,'href')||'')}"></div>`
          );
        if (t === 'img') h += grp('Image',
          `<div class="shb-dv-f"><label>Image URL</label><input type="text" id="cSrc" value="${esc(getAttr(k,'src')||'')}"></div><div class="shb-dv-f"><label>Alt text <span style="color:#b7791f">${getAttr(k,'alt')==null?'· missing':''}</span></label><input type="text" id="cAlt" value="${esc(getAttr(k,'alt')||'')}" placeholder="Describe the image"></div>`
          );
        if (!(r.editable && r.close > -1) && t !== 'a' && t !== 'img') h += grp('Contents',
          `<p style="margin:0;font-size:12.5px;color:var(--mu)">${el.children.length} items inside. Hover them on the page to edit each one, or use the Design tab for this ${kind(el)==='sec'?'section':'row'}.</p>`
          );
      }
      if (tab === 'design') {
        const fs = parseInt(cs.fontSize),
          pt = parseInt(cs.paddingTop),
          pb = parseInt(cs.paddingBottom),
          br = parseInt(cs.borderTopLeftRadius) || 0;
        h += grp('Text', clr('dColor', 'Text colour', hex(cs.color)) + rng('dSize', 'Text size', fs, 10, 72) +
          `<div class="shb-dv-f"><label>Alignment</label><div class="shb-dv-seg" id="dAlign">${['left','center','right'].map(a=>`<button data-v="${a}" class="${cs.textAlign===a||(a==='left'&&cs.textAlign==='start')?'on':''}">${a[0].toUpperCase()+a.slice(1)}</button>`).join('')}</div></div><div class="shb-dv-f"><label>Weight</label><div class="shb-dv-seg" id="dWeight">${[['400','Regular'],['600','Semibold'],['800','Bold']].map(([v,n])=>`<button data-v="${v}" class="${String(cs.fontWeight)===v?'on':''}">${n}</button>`).join('')}</div></div>`
          );
        h += grp('Background', clr('dBg', 'Background colour', hex(cs.backgroundColor)));
        h += grp('Spacing', rng('dPt', 'Padding top', pt, 0, 160) + rng('dPb', 'Padding bottom', pb, 0, 160));
        h += grp('Border', rng('dBr', 'Corner radius', br, 0, 48), true);
      }
      if (tab === 'advanced') {
        h += grp('CSS ID & classes',
          `<div class="shb-dv-f"><label>CSS ID</label><input type="text" id="aId" value="${esc(getAttr(k,'id')||'')}"></div><div class="shb-dv-f"><label>CSS class</label><input type="text" id="aClass" value="${esc(getAttr(k,'class')||'')}"></div>`
          );
        h += grp('Custom CSS',
          `<div class="shb-dv-f"><label>Inline style on this element</label><textarea class="mono" id="aStyle" rows="4">${esc(getAttr(k,'style')||'')}</textarea></div>`
          );
        h += grp('Source',
          `<p style="margin:0 0 8px;font-size:12.5px;color:var(--mu)">Lines ${lineAt(r.start)}–${lineAt(r.end)} of ${esc(fileName())}. Every change here is written straight into the file.</p><button id="aCode" style="border:1px solid var(--ln);background:var(--card);border-radius:8px;padding:6px 12px;font-size:12.5px">Show in code</button>`
          );
      }
      $('mBody').innerHTML = h;
      wireModal()
    }

    function wireModal() {
      const k = sel;
      $('mBody').querySelectorAll('[data-reset]').forEach(c => c.onclick = ev => {
        ev.preventDefault();
        setStyle(k, c.dataset.reset, '');
        setTimeout(() => {
          render();
          setTimeout(fillModal, 150)
        }, 50);
        toast('Reset to the page style', true)
      });
      $('mBody').querySelectorAll('.shb-dv-gh').forEach(g => g.onclick = () => g.parentElement.classList.toggle(
        'shut'));
      const on = (id, ev, fn) => {
        const e = $(id);
        if (e) e[ev] = fn
      };
      on('cText', 'oninput', e => setText(k, e.target.value));
      on('cHref', 'oninput', e => setAttr(k, 'href', e.target.value, {
        reload: false,
        merge: true
      }));
      on('cSrc', 'oninput', e => {
        setAttr(k, 'src', e.target.value, {
          reload: false,
          merge: true
        });
        elOf(k).src = e.target.value
      });
      on('cAlt', 'oninput', e => setAttr(k, 'alt', e.target.value, {
        reload: false,
        merge: true
      }));
      [
        ['dColor', 'color'],
        ['dBg', 'background']
      ].forEach(([id, p]) => on(id, 'oninput', e => {
        e.target.nextElementSibling.textContent = e.target.value;
        setStyle(k, p, e.target.value)
      }));
      $('mBody').querySelectorAll('.shb-dv-sw i').forEach(i => i.onclick = () => {
        const inp = $(i.dataset.for);
        inp.value = i.dataset.c;
        inp.dispatchEvent(new Event('input'))
      });
      [
        ['dSize', 'font-size'],
        ['dPt', 'padding-top'],
        ['dPb', 'padding-bottom'],
        ['dBr', 'border-radius']
      ].forEach(([id, p]) => on(id, 'oninput', e => {
        e.target.nextElementSibling.textContent = e.target.value + 'px';
        setStyle(k, p, e.target.value + 'px')
      }));
      [
        ['dAlign', 'text-align'],
        ['dWeight', 'font-weight']
      ].forEach(([id, p]) => {
        const s = $(id);
        if (s) s.onclick = e => {
          const b = e.target.closest('button');
          if (!b) return;
          [...s.children].forEach(x => x.classList.toggle('on', x === b));
          setStyle(k, p, b.dataset.v)
        }
      });
      on('aId', 'oninput', e => setAttr(k, 'id', e.target.value, {
        reload: false,
        merge: true
      }));
      on('aClass', 'onchange', e => setAttr(k, 'class', e.target.value));
      on('aStyle', 'onchange', e => setAttr(k, 'style', e.target.value));
      on('aCode', 'onclick', () => showInSource(elOf(sel)));
      on('askGo', 'onclick', ask);
      on('askIn', 'onkeydown', e => {
        if (e.key === 'Enter') ask()
      })
    }
    async function ask() {
      if (!options.onAskSulla) return;
      const instruction = $('askIn').value.trim();
      if (!instruction) return;
      const key = sel;
      const range = locate(key);
      const box = $('propBox');
      const before = src.slice(range.start, range.end);
      box.innerHTML =
        `<p style="margin:8px 0 0;font-size:12px;color:var(--dim)">Sulla is rewriting lines ${lineAt(range.start)}–${lineAt(range.end)}…</p>`;
      const replacement = await options.onAskSulla({
        instruction,
        selectionHtml: before,
        start: range.start,
        end: range.end,
        fileName: $('fname').value,
      });
      if (replacement == null || !locate(key)) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML =
        `<div class="shb-dv-prop" style="margin-top:8px"><div class="o">${esc(before)}</div><div class="n">${esc(replacement)}</div><div class="r"><button id="pN">Discard</button><button class="y" id="pY">Apply</button></div></div>`;
      $('pN').onclick = () => {
        box.innerHTML = '';
      };
      $('pY').onclick = () => {
        const current = locate(key);
        nextLabel = 'Ask Sulla';
        setSrc(patchSource(src, current.start, current.end, replacement));
        $('askIn').value = '';
        setTimeout(fillModal, 120);
        toast('Sulla change applied', true);
      };
    }
    $('mFind').oninput = () => {
      const q = $('mFind').value.trim().toLowerCase();
      if (!q) {
        fillModal();
        return
      }
      const all = [];
      for (const t of ['content', 'design', 'advanced']) {
        tab = t;
        fillModal();
        $('mBody').querySelectorAll('.shb-dv-f').forEach(f => {
          if (f.textContent.toLowerCase().includes(q) || f.closest('.shb-dv-grp').querySelector('.shb-dv-gh')
            .textContent.toLowerCase().includes(q)) all.push(f.outerHTML)
        })
      }
      tab = 'content';
      [...$('mTabs').children].forEach(x => x.classList.toggle('on', false));
      $('mBody').innerHTML = all.length ?
        `<div class="shb-dv-grp"><div class="shb-dv-gb" style="padding-top:12px">${all.join('')}</div></div>` :
        '<p style="padding:16px;margin:0;font-size:12.5px;color:var(--dim)">No setting matches “' + esc(q) +
        '”.</p>';
      wireModal()
    };
    $('mTabs').onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      tab = b.dataset.t;
      [...$('mTabs').children].forEach(x => x.classList.toggle('on', x === b));
      fillModal()
    };
    $('mX').onclick = () => closeModal(true);
    $('fOk').onclick = () => {
      closeModal(true);
      toast('Settings applied to ' + fileName())
    };
    $('fX').onclick = () => {
      closeModal(false);
      toast('Changes discarded')
    };
    $('fU').onclick = doUndo;
    $('fR').onclick = doRedo;
    $('mDock').onclick = () => {
      $('modal').classList.toggle('docked');
      saveModalPos();
      setTimeout(draw, 50)
    };
    (() => {
      let sx, sy, ox, oy;
      $('mh').onmousedown = e => {
        if (e.target.closest('button') || $('modal').classList.contains('docked')) return;
        const m = $('modal');
        sx = e.clientX;
        sy = e.clientY;
        ox = m.offsetLeft;
        oy = m.offsetTop;
        frame.style.pointerEvents = 'none';
        const mv = ev => {
          m.style.left = (ox + ev.clientX - sx) + 'px';
          m.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'
        };
        const up = () => {
          frame.style.pointerEvents = '';
          saveModalPos();
          removeEventListener('mousemove', mv);
          removeEventListener('mouseup', up)
        };
        addEventListener('mousemove', mv);
        addEventListener('mouseup', up)
      }
    })();
    // ---------- library ----------
    const LAYOUTS = [
      ['Hero', 'Big headline, line and button',
        `<section class="hero">\n    <h1>A headline that says what you do</h1>\n    <p>One sentence on why it matters to the customer.</p>\n    <a class="cta" href="#">Get started</a>\n  </section>`,
        [60, 90, 40]
      ],
      ['Three features', 'Cards in a row',
        `<section class="features">\n    <div class="card">\n      <h3>Feature one</h3>\n      <p>Short benefit line.</p>\n    </div>\n    <div class="card">\n      <h3>Feature two</h3>\n      <p>Short benefit line.</p>\n    </div>\n    <div class="card">\n      <h3>Feature three</h3>\n      <p>Short benefit line.</p>\n    </div>\n  </section>`,
        [30, 30, 30]
      ],
      ['Testimonial', 'One quote, centred',
        `<section style="padding: 56px 40px; text-align: center">\n    <blockquote style="font-size: 24px; margin: 0 auto 12px; max-width: 640px">“A short quote from a happy customer.”</blockquote>\n    <p style="color: #8a7f70">Customer name, City</p>\n  </section>`,
        [80, 50]
      ],
      ['Call to action', 'Dark band with a button',
        `<section style="padding: 48px 40px; background: #1f2a37; color: #fff; text-align: center">\n    <h2 style="margin: 0 0 18px">Ready to get started?</h2>\n    <a class="cta" href="#">Get started</a>\n  </section>`,
        [70, 35]
      ],
      ['FAQ', 'Questions that open',
        `<section style="padding: 40px">\n    <h2>Questions</h2>\n    <details>\n      <summary>A common question?</summary>\n      <p>A short, clear answer.</p>\n    </details>\n    <details>\n      <summary>Another question?</summary>\n      <p>Another short answer.</p>\n    </details>\n  </section>`,
        [40, 90, 90, 90]
      ],
      ['Blank section', 'Start from nothing',
        `<section style="padding: 48px 40px">\n    <p>New section</p>\n  </section>`, [50]
      ]
    ];
    const MODS = [
      ['Heading', '<h3>New heading</h3>', 'M6 4v16M18 4v16M6 12h12'],
      ['Text', '<p>New paragraph. Click to edit.</p>', 'M4 6h16M4 12h16M4 18h10'],
      ['Button', '<a class="cta" href="#">Button</a>', 'M3 8h18v8H3z'],
      ['Image', '<img src="https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1000&q=60" alt="">',
        'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6'
      ],
      ['Divider', '<hr>', 'M3 12h18']
    ];
    let libFor = null;

    function openLib(type, anchor) {
      libFor = {
        type,
        k: anchor && keyOf(anchor)
      };
      $('libTitle').textContent = type === 'sec' ? 'Add a section' : 'Add a module';
      const g = $('libGrid');
      g.className = 'shb-dv-lg' + (type === 'mod' ? ' shb-dv-mods' : '');
      g.innerHTML = type === 'sec' ? LAYOUTS.map((l, i) =>
        `<button data-i="${i}"><div class="th">${l[3].map(w=>`<i style="width:${w}%;${w>80?'height:12px':''}"></i>`).join('')}</div><div class="nm">${l[0]}<small>${l[1]}</small></div></button>`
        ).join('') : MODS.map((m, i) =>
        `<button data-i="${i}"><svg viewBox="0 0 24 24"><path d="${m[2]}"/></svg>${m[0]}</button>`).join('');
      g.querySelectorAll('button').forEach(b => b.onclick = () => insert(+b.dataset.i));
      $('lib').classList.add('on');
      $('dim').classList.add('on')
    }

    function closeLib() {
      $('lib').classList.remove('on');
      $('dim').classList.remove('on')
    }

    function insert(i) {
      const {
        type,
        k
      } = libFor;
      closeLib();
      const r = k && locate(k);
      const at = r ? r.end : src.lastIndexOf('</body>');
      const ind = r ? indentAt(r.start) : '  ';
      const html = type === 'sec' ? LAYOUTS[i][2] : MODS[i][1];
      nextLabel = 'Added ' + (type === 'sec' ? LAYOUTS[i][0] : MODS[i][0]);
      setSrc(src.slice(0, at) + '\n' + ind + html + src.slice(at));
      hov = null;
      toast((type === 'sec' ? LAYOUTS[i][0] + ' section' : MODS[i][0]) + ' added as real HTML', true)
    }
    $('libX').onclick = closeLib;
    $('dim').onclick = closeLib;
    // ---------- context menu ----------
    function openCtx(el, x, y) {
      if (el === doc().body) return;
      const c = $('ctx');
      const items = [
        ['Settings', () => openSettings(el)],
        ...(options.onAskSulla ? [['Ask Sulla…', () => act('ai', el)]] : []),
        ['Show in source', () => showInSource(el)], null, ['Copy style', () => {
          styleClip = getAttr(keyOf(el), 'style') || '';
          toast(styleClip ? 'Style copied' : 'This element has no own style')
        }],
        ['Apply this style to all similar', () => extendStyle(el)],
        ['Paste style', () => {
          if (styleClip == null) {
            toast('Copy a style first');
            return
          }
          setAttr(keyOf(el), 'style', styleClip);
          toast('Style pasted', true)
        }], null, ['Duplicate', () => act('dup', el)],
        ['Delete', () => act('del', el), 'del']
      ];
      c.innerHTML =
        `<div style="padding:6px 10px 4px;font-size:11px;color:var(--dim);font-weight:600;letter-spacing:.04em">${label(el).toUpperCase()}</div>` +
        items.map((it, i) => it ? `<button data-i="${i}" class="${it[2]||''}">${it[0]}</button>` : '<hr>').join('');
      c.querySelectorAll('button').forEach(b => b.onclick = () => {
        hideCtx();
        items[+b.dataset.i][1]()
      });
      c.style.left = Math.min(x, innerWidth - 220) + 'px';
      c.style.top = Math.min(y, innerHeight - 300) + 'px';
      c.classList.add('on')
    }

    function extendStyle(el) {
      const st = getAttr(keyOf(el), 'style');
      if (!st) {
        toast('This element has no own style to share');
        return
      }
      const cls = typeof el.className === 'string' ? el.className.trim() : '';
      const sims = [...doc().getElementsByTagName(el.tagName)].filter(x => x !== el && x.parentElement
        ?.parentElement === el.parentElement?.parentElement && (typeof x.className === 'string' ? x.className
        .trim() : '') === cls);
      if (!sims.length) {
        toast('No similar elements found');
        return
      }
      const keys = sims.map(keyOf);
      let s = src;
      const save = src;
      keys.sort((a, b) => b.i - a.i).forEach(k => {
        src = s;
        const r = locate(k);
        let open = s.slice(r.start, r.openEnd);
        open = /\sstyle="/.test(open) ? open.replace(/\sstyle="[^"]*"/, ` style="${st}"`) : open.replace(
          /\s*(\/?>)$/, ` style="${st}"$1`);
        s = s.slice(0, r.start) + open + s.slice(r.openEnd)
      });
      src = save;
      const nm = cls || label(el).toLowerCase();
      nextLabel = 'Style applied to all ' + (sims.length + 1) + ' ' + nm + 's';
      setSrc(s);
      toast('Style applied to ' + sims.length + ' more ' + nm + (sims.length > 1 ? 's' : ''), true)
    }

    function hideCtx() {
      $('ctx').classList.remove('on')
    }
    rootEl.addEventListener('click', e => {
      if (!e.target.closest('#ctx')) hideCtx()
    });
    // ---------- wireframe ----------
    function buildWire() {
      const w = $('wire'),
        secs = [...doc().body.children].filter(e => !['SCRIPT', 'STYLE'].includes(e.tagName));
      const mods = el => [...el.children].map(c => kind(c) === 'row' ?
        `<div class="shb-dv-wrow"><em>${label(c)}</em>${mods(c)}</div>` :
        `<div class="shb-dv-wmod" data-t="${c.tagName.toLowerCase()}" data-i="${keyOf(c).i}">${label(c)}${c.textContent.trim()?' · '+esc(c.textContent.trim().slice(0,30)):''}</div>`
        ).join('');
      w.innerHTML = secs.map((s, i) =>
        `<div class="shb-dv-wsec" draggable="true" data-i="${i}"><div class="shb-dv-wsh"><svg viewBox="0 0 24 24"><path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/></svg><span>${label(s)}</span><button data-g="${i}" title="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg></button></div><div class="shb-dv-wb">${s.children.length?mods(s):`<div class="shb-dv-wmod" data-t="${s.tagName.toLowerCase()}" data-i="${keyOf(s).i}">${label(s)}${s.textContent.trim()?' · '+esc(s.textContent.trim().slice(0,30)):''}</div>`}</div></div>`
        ).join('');
      w.querySelectorAll('.shb-dv-wmod').forEach(m => m.onclick = () => openSettings(elOf({
        tag: m.dataset.t,
        i: +m.dataset.i
      })));
      w.querySelectorAll('[data-g]').forEach(b => b.onclick = e => {
        e.stopPropagation();
        openSettings(secs[+b.dataset.g])
      });
      let from = null;
      w.querySelectorAll('.shb-dv-wsec').forEach(s => {
        s.ondragstart = () => {
          from = +s.dataset.i;
          s.classList.add('drag')
        };
        s.ondragend = () => s.classList.remove('drag');
        s.ondragover = e => {
          e.preventDefault();
          s.classList.add('over')
        };
        s.ondragleave = () => s.classList.remove('over');
        s.ondrop = e => {
          e.preventDefault();
          s.classList.remove('over');
          const to = +s.dataset.i;
          if (from == null || from === to) return;
          moveSection(from, to)
        }
      })
    }

    function moveSection(from, to) {
      let secs = () => [...doc().body.children].filter(e => !['SCRIPT', 'STYLE'].includes(e.tagName));
      // adjacent swaps on the source keep all other whitespace untouched
      let cur = from;
      const steps = [];
      while (cur !== to) {
        steps.push(cur < to ? [cur, cur + 1] : [cur - 1, cur]);
        cur += cur < to ? 1 : -1
      }
      let s = src;
      const before = src;
      for (const [a, b] of steps) {
        const tmp = document.createElement('template');
        const d2 = new DOMParser().parseFromString(s, 'text/html');
        const list = [...d2.body.children].filter(e => !['SCRIPT', 'STYLE'].includes(e.tagName));
        const keyIn = el => {
          const t = el.tagName.toLowerCase();
          return {
            tag: t,
            i: [...d2.getElementsByTagName(t)].indexOf(el)
          }
        };
        const save = src;
        src = s;
        const ra = locate(keyIn(list[a])),
          rb = locate(keyIn(list[b]));
        s = s.slice(0, ra.start) + s.slice(rb.start, rb.end) + s.slice(ra.end, rb.start) + s.slice(ra.start, ra.end) +
          s.slice(rb.end);
        src = save
      }
      nextLabel = 'Reordered sections';
      setSrc(s);
      toast('Section moved', true)
    }

    function toggleWire(force) {
      const on = $('wire').classList.toggle('on', force);
      hov = null;
      draw();
      if (on) buildWire()
    }
    // ---------- code drawer ----------
    function highlight(s) {
      let out = '',
        re = /(<!--[\s\S]*?-->)|(<!doctype[^>]*>)|(<\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?>)/gi,
        last = 0,
        m;
      while ((m = re.exec(s))) {
        out += esc(s.slice(last, m.index));
        if (m[1]) out += `<span class="t-cm">${esc(m[1])}</span>`;
        else if (m[2]) out += `<span class="t-dt">${esc(m[2])}</span>`;
        else {
          const a = esc(m[5]).replace(/([\w:-]+)(=)("[^"]*"|'[^']*')?/g, (x, n, eq, v) =>
            `<span class="t-at">${n}</span>${eq}${v?`<span class="t-st">${v}</span>`:''}`);
          out += `<span class="t-tag">${esc(m[3])}${m[4]}</span>${a}<span class="t-tag">${esc(m[6])}</span>`
        }
        last = re.lastIndex
      }
      return out + esc(s.slice(last))
    }

    function renderCode() {
      if (typeof buildTree === 'function') setTimeout(buildTree, 200);
      $('hl').innerHTML = highlight(src) + '\n';
      const L = src.split('\n');
      $('gut').textContent = L.map((_, i) => i + 1).join('\n');
      $('ta').style.height = (L.length * 20 + 72) + 'px';
      $('hl').parentElement.style.minWidth = Math.max(...L.map(l => l.length)) * 7.6 + 40 + 'px';
      showBand()
    }

    function showBand() {
      const r = sel && locate(sel),
        b = $('band');
      if (!r) {
        b.style.display = 'none';
        return
      }
      const a = lineAt(r.start),
        z = lineAt(r.end);
      b.style.display = 'block';
      b.style.top = (12 + (a - 1) * 20) + 'px';
      b.style.height = ((z - a + 1) * 20) + 'px';
      if ($('code').classList.contains('on')) {
        const sc = $('scroll'),
          y = 12 + (a - 1) * 20;
        if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - 60) sc.scrollTo({
          top: y - 60,
          behavior: 'smooth'
        })
      }
    }

    $('ta').addEventListener('input', () => setSrc($('ta').value, {
      merge: true
    }));
    $('ta').addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const t = $('ta');
        t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
        setSrc(t.value, {
          merge: true
        })
      }
    });
    // ---------- dock + misc ----------
    host.querySelectorAll('.dev').forEach(b => b.onclick = () => {
      host.querySelectorAll('.dev').forEach(x => x.classList.toggle('on', x === b));
      frame.style.width = b.dataset.w;
      $('stage').classList.toggle('narrow', b.dataset.w !== '100%');
      hov = null;
      setTimeout(draw, 300)
    });
    $('bUndo').onclick = doUndo;
    $('bRedo').onclick = doRedo;
    if ($('bHist')) $('bHist').onclick = e => {
      e.stopPropagation();
      const h = $('hist');
      if (h.classList.contains('on')) {
        h.classList.remove('on');
        return
      }
      const fmt = d => d ? d.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      }) : '';
      const rows = [...undo.map((u, i) => ({
        l: u.label,
        at: u.at,
        i,
        kind: 'past'
      })), {
        l: 'Now',
        kind: 'cur'
      }, ...[...redo].reverse().map((r, i) => ({
        l: r.label,
        at: r.at,
        i,
        kind: 'fut'
      }))];
      h.innerHTML = '<h4>THIS SESSION</h4>' + (undo.length || redo.length ? rows.map((r, j) =>
          `<button data-j="${j}" class="${r.kind==='cur'?'cur':r.kind==='fut'?'fut':''}">${esc(r.l)}<small>${fmt(r.at)}</small></button>`
          ).join('') : '<p style="margin:4px 10px 10px;font-size:12.5px;color:var(--dim)">No edits yet.</p>') +
        (options.onHistory ? '<h4 style="margin-top:10px">SAVED VERSIONS</h4><button id="histAll">Open version history…</button>' : '');
      h.querySelectorAll('[data-j]').forEach(b => b.onclick = () => {
        const r = rows[+b.dataset.j];
        if (r.kind === 'past') {
          const n = undo.length - r.i;
          for (let x = 0; x < n; x++) doUndo()
        } else if (r.kind === 'fut') {
          for (let x = 0; x <= r.i; x++) doRedo()
        }
        h.classList.remove('on')
      });
      const br = $('bHist').getBoundingClientRect();
      h.style.left = Math.min(br.left - 130, innerWidth - 310) + 'px';
      h.style.top = (br.bottom + 8) + 'px';
      h.style.bottom = 'auto';
      h.classList.add('on')
    };
    rootEl.addEventListener('click', e => {
      if (!e.target.closest('#hist')) $('hist').classList.remove('on')
    });

    function dirty() {
      const s = $('save');
      s.classList.add('dirty');
      // The host owns the real save state (setSaveState); only mark unsaved here.
      s.lastElementChild.textContent = 'Not saved';
    }

    function toast(m, u) {
      const t = $('toast');
      t.innerHTML = esc(m) + (u ? '<button id="tU">Undo</button>' : '');
      t.style.pointerEvents = u ? 'auto' : 'none';
      if (u) $('tU').onclick = () => {
        doUndo();
        t.classList.remove('on')
      };
      t.classList.add('on');
      clearTimeout(toast.t);
      toast.t = setTimeout(() => {
        t.classList.remove('on');
        t.style.pointerEvents = 'none'
      }, u ? 5000 : 2200)
    }

    function keys(e) {
      if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey) {
        const K = e.key.toLowerCase();
        const M = {
          z: () => e.shiftKey ? doRedo() : doUndo(),
          u: () => toggleSource(),
          r: () => {
            if (!editing) render()
          },
          s: () => options.onSave?.(),
          f: () => openFindReplace(),
          d: () => withSel(el => act('dup', el)),
          e: () => withSel(el => openSettings(el)),
          i: () => startPick(),
          p: () => window.print()
        };
        if (M[K]) {
          e.preventDefault();
          M[K]()
        }
        return
      }
      const K = e.key.toLowerCase();
      if (K === 'e') {
        setEditing(!editing);
        return
      }
      if (!editing && K !== '1' && K !== '2' && K !== 'f' && K !== '?') return;
      if (K === 'w') toggleWire();
      if (K === 'o') toggleFly();
      if (K === 'f') toggleFocus();
      if (K === '1') setView('builder');
      if (K === '2') setView('workbench');
      if (K === '?') showKeys();
      if (e.key === 'Escape') {
        if (picking) {
          stopPick();
          return
        }
        closeMenu();
        toggleFly(false);
        $('probs').classList.remove('on');
        closeDlg();
        hideCtx();
        closeLib();
        if ($('modal').classList.contains('on')) closeModal(true)
      }
    }
    rootEl.addEventListener('keydown', keys);
    addEventListener('resize', draw);

    // ================= merged editor: views, menus, inspect =================
    let lastPick = null,
      picking = false,
      view = 'builder';
    const target = () => elOf(sel) || ((lastPick && doc()?.contains(lastPick)) ? lastPick : null);

    function withSel(fn) {
      const el = target();
      if (!el) {
        toast('Click something on the page first');
        return
      }
      fn(el)
    }

    function setView(v) {
      view = v;
      rootEl.classList.remove('v-builder', 'v-workbench', 'v-source');
      rootEl.classList.add('v-' + v);
      [...$('views').children].forEach(b => b.classList.toggle('on', b.dataset.v === v || (v === 'source' && b.dataset
        .v === 'workbench' && false)));
      $('code').classList.toggle('on', v !== 'builder');
      $('bSource').classList.toggle('on', v === 'source');
      $('codeTitle').textContent = (v === 'source' ? 'Source code' : 'Source') + ' · ' + fileName();
      hov = null;
      setTimeout(() => {
        draw();
        showBand()
      }, 60);
      localStorage.setItem('sulla.htmlEditor.view', v)
    }
    let lastPageView = 'builder';

    function toggleSource() {
      if (view === 'source') setView(lastPageView);
      else {
        lastPageView = view;
        setView('source')
      }
    }
    $('views').onclick = e => {
      const b = e.target.closest('button');
      if (b) setView(b.dataset.v)
    };
    $('bSource').onclick = toggleSource;
    $('codeX').onclick = () => setView('builder');

    function showInSource(el) {
      if (!el) return;
      sel = keyOf(el);
      if (view === 'builder') setView('workbench');
      const range = locate(sel);
      if (range && externalSourceEditor) externalSourceEditor.revealRange(range.start, range.end);
      setTimeout(showBand, 80);
      hov = el;
      draw()
    }
    // divider
    $('drag').onmousedown = e => {
      const w = $('work').getBoundingClientRect();
      $('drag').classList.add('on');
      frame.style.pointerEvents = 'none';
      const mv = ev => {
        $('code').style.flexBasis = Math.min(75, Math.max(20, (ev.clientX - w.left) / w.width * 100)) + '%';
        draw()
      };
      const up = () => {
        $('drag').classList.remove('on');
        frame.style.pointerEvents = '';
        removeEventListener('mousemove', mv);
        removeEventListener('mouseup', up)
      };
      addEventListener('mousemove', mv);
      addEventListener('mouseup', up)
    };
    // source caret -> page
    $('ta').addEventListener('click', () => {
      const c = $('ta').selectionStart,
        d = doc();
      if (!d) return;
      let best = null;
      [...d.body.querySelectorAll('*')].forEach(el => {
        const r = locate(keyOf(el));
        if (r && r.start <= c && c <= r.end && (!best || r.start >= best.r.start)) best = {
          el,
          r
        }
      });
      if (best) {
        lastPick = best.el;
        hov = best.el;
        best.el.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        });
        setTimeout(draw, 300)
      }
    });
    // layers
    function toggleFly(on) {
      $('fly').classList.toggle('on', on ?? !$('fly').classList.contains('on'));
      if ($('fly').classList.contains('on')) buildTree()
    }
    $('flyX').onclick = () => toggleFly(false);

    function buildTree() {
      const d = doc();
      if (!d?.body || !$('fly').classList.contains('on')) return;
      const rows = [];
      (function walk(el, dep) {
        [...el.children].forEach(c => {
          if (['SCRIPT', 'STYLE'].includes(c.tagName)) return;
          const k = kind(c),
            kk = keyOf(c);
          rows.push(
            `<div class="${k==='sec'?'s':k==='row'?'r':'m'}${sel&&sel.tag===kk.tag&&sel.i===kk.i?' sel':''}" data-t="${kk.tag}" data-i="${kk.i}" style="padding-left:${12+dep*14}px"><b>${label(c)}</b>${k==='mod'&&c.textContent.trim()?` <span style="color:var(--dim)">${esc(c.textContent.trim().slice(0,18))}</span>`:''}</div>`
            );
          if (k !== 'mod') walk(c, dep + 1)
        })
      })(d.body, 0);
      $('tree').innerHTML = rows.join('');
      $('tree').querySelectorAll('div').forEach(r => {
        const el = elOf({
          tag: r.dataset.t,
          i: +r.dataset.i
        });
        r.onmouseenter = () => {
          hov = el;
          draw()
        };
        r.onclick = () => {
          el.scrollIntoView({
            block: 'center',
            behavior: 'smooth'
          });
          setTimeout(() => openSettings(el), 300)
        }
      })
    }
    // focus
    function toggleFocus() {
      rootEl.classList.toggle('focus');
      $('bFocus').classList.toggle('on');
      setTimeout(draw, 250);
      if (rootEl.classList.contains('focus')) toast(
        'Focus on · move to the top edge or press F to bring the bar back')
    }
    $('bFocus').onclick = toggleFocus;
    $('hot').onmouseenter = () => rootEl.classList.add('peek');
    $('bar').onmouseleave = () => rootEl.classList.remove('peek');
    // inspect picker
    function startPick() {
      picking = true;
      rootEl.classList.add('picking');
      closeMenu()
    }

    function stopPick() {
      picking = false;
      rootEl.classList.remove('picking')
    }

    function pickDone(el) {
      stopPick();
      lastPick = el;
      showInSource(el);
      toast(label(el) + ' · lines ' + lineAt(locate(keyOf(el)).start) + '–' + lineAt(locate(keyOf(el)).end))
    }
    // dialogs
    function openDlg(title, html, wide) {
      $('dlgTitle').textContent = title;
      $('dlgBody').innerHTML = html;
      $('dlg').style.width = wide ? 'min(760px,92vw)' : 'min(480px,92vw)';
      $('dlg').classList.add('on');
      $('dim').classList.add('on')
    }

    function closeDlg() {
      $('dlg').classList.remove('on');
      if (!$('lib').classList.contains('on')) $('dim').classList.remove('on')
    }
    $('dlgX').onclick = closeDlg;
    $('dim').addEventListener('click', closeDlg);

    function showKeys() {
      const K = [
        ['Editing on / off', 'E'],
        ['Builder / Workbench', '1 / 2'],
        ['Source code', '⌘U'],
        ['Wireframe', 'W'],
        ['Layers', 'O'],
        ['Focus mode', 'F'],
        ['Element settings', '⌘E'],
        ['Inspect element', '⌘I'],
        ['Find & replace', '⌘F'],
        ['Duplicate', '⌘D'],
        ['Undo / Redo', '⌘Z / ⇧⌘Z'],
        ['Save', '⌘S'],
        ['Close / deselect', 'Esc']
      ];
      openDlg('Keyboard shortcuts', '<div class="shb-wb-keys">' + K.map(k =>
        `<div><span>${k[0]}</span><kbd>${k[1]}</kbd></div>`).join('') + '</div>', true)
    }

    function pageSettings() {
      const title = (src.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const desc = (src.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
      const lang = (src.match(/<html[^>]*lang="([^"]*)"/) || [])[1] || '';
      openDlg('Page settings',
        `<div style="padding:18px"><div class="shb-dv-f"><label>Page title (browser tab and search results)</label><input type="text" id="psT" value="${esc(title)}"></div><div class="shb-dv-f"><label>Description (search results and link previews)${desc?'':' <span style="color:#b7791f">· missing</span>'}</label><textarea id="psD" rows="3" placeholder="One or two sentences about this page">${esc(desc)}</textarea></div><div class="shb-dv-f"><label>Language</label><input type="text" id="psL" value="${esc(lang)}"></div><div style="display:flex;justify-content:flex-end;gap:8px"><button class="shb-dv-seg" style="padding:7px 14px;border-radius:8px" id="psX">Cancel</button><button id="psOk" style="border:0;background:var(--ac);color:#fff;font-weight:600;padding:7px 16px;border-radius:8px">Save to the page head</button></div></div>`
        );
      $('psX').onclick = closeDlg;
      $('psOk').onclick = () => {
        let s = src;
        const T = $('psT').value,
          Dd = $('psD').value,
          Lg = $('psL').value;
        s = s.replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(T) + '</title>');
        if (/<meta name="description"/.test(s)) s = s.replace(/<meta name="description" content="[^"]*">/, Dd ?
          `<meta name="description" content="${Dd.replace(/"/g,'&quot;')}">` : '');
        else if (Dd) s = s.replace(/(\n(\s*)<title>.*<\/title>)/,
          `$1\n$2<meta name="description" content="${Dd.replace(/"/g,'&quot;')}">`);
        s = s.replace(/<html([^>]*?)lang="[^"]*"/, `<html$1lang="${Lg}"`);
        nextLabel = 'Page settings';
        setSrc(s);
        closeDlg();
        toast('Page title and description saved', true)
      }
    }
    // find & replace
    function openFindReplace() {
      closeMenu();
      openDlg('Find & replace',
        `<div style="padding:18px"><div class="shb-dv-f"><label>Find (in page text and code)</label><input type="text" id="frF"></div><div class="shb-dv-f"><label>Replace with</label><input type="text" id="frR"></div><div style="display:flex;align-items:center;gap:8px"><span id="frN" style="flex:1;font-size:12.5px;color:var(--dim)"></span><button id="frOne" style="border:1px solid var(--ln);background:var(--card);border-radius:8px;padding:6px 12px">Replace</button><button id="frAll" style="border:0;background:var(--ac);color:#fff;border-radius:8px;padding:6px 12px;font-weight:600">Replace all</button></div></div>`
        );
      const n = () => {
        const q = $('frF').value;
        $('frN').textContent = q ? (src.split(q).length - 1) + ' found' : ''
      };
      $('frF').oninput = n;
      setTimeout(() => $('frF').focus(), 30);
      $('frOne').onclick = () => {
        const q = $('frF').value;
        if (!q || !src.includes(q)) return;
        nextLabel = 'Replace "' + q + '"';
        setSrc(src.replace(q, $('frR').value));
        n();
        toast('Replaced 1', true)
      };
      $('frAll').onclick = () => {
        const q = $('frF').value;
        if (!q) return;
        const c = src.split(q).length - 1;
        if (!c) return;
        nextLabel = 'Replace all "' + q + '"';
        setSrc(src.split(q).join($('frR').value));
        n();
        toast('Replaced ' + c, true)
      }
    }
    // page check
    function checkPage() {
      closeMenu();
      const d = doc(),
        out = [];
      tokenize(src).diagnostics.forEach(problem => {
        out.push(['warn', problem.message, `HTML source · line ${lineAt(problem.start)}`, null, 'source', problem.start,
          problem.end
        ])
      });
      [...d.links].forEach(a => {
        const h = a.getAttribute('href');
        if (!h || h === '#') out.push(['warn', 'Link goes nowhere', '“' + a.textContent.trim().slice(0, 30) +
          '” has href="' + (h || '') + '"', a
        ])
      });
      if (!/<meta name="description"/.test(src)) out.push(['warn', 'No page description',
        'Search results and link previews will guess one', null, 'page'
      ]);
      const hs = [...d.querySelectorAll('h1,h2,h3,h4')];
      let prev = 0;
      hs.forEach(h => {
        const l = +h.tagName[1];
        if (prev && l > prev + 1) out.push(['info', 'Heading skips a level', h.tagName + ' after H' + prev +
          ': “' + h.textContent.trim().slice(0, 28) + '”', h
        ]);
        prev = l
      });
      if (d.querySelectorAll('h1').length !== 1) out.push(['warn', 'Page should have one main heading (H1)',
        'Found ' + d.querySelectorAll('h1').length, null
      ]);
      const p = $('probs');
      p.innerHTML =
        `<h4><span>Page check · ${out.length?out.length+' to look at':'all good'}</span><button id="probX">×</button></h4>` +
        (out.length ? out.map((o, i) =>
          `<button class="it" data-i="${i}"><b class="b-${o[0]}">${o[0]==='warn'?'Fix':'Tip'}</b>${o[1]}<small>${esc(o[2])}</small></button>`
          ).join('') : '<div class="it"><b class="b-ok">OK</b>No problems found.</div>');
      p.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
        const o = out[+b.dataset.i];
        if (o[4] === 'page') {
          pageSettings();
          return
        }
        if (o[4] === 'source') {
          if (view === 'builder') setView('workbench');
          if (externalSourceEditor) externalSourceEditor.revealRange(o[5], o[6]);
          else {
            $('ta').focus();
            $('ta').setSelectionRange(o[5], o[6]);
            $('scroll').scrollTop = Math.max(0, (lineAt(o[5]) - 2) * 20)
          }
          return
        }
        if (o[3]) {
          o[3].scrollIntoView({
            block: 'center',
            behavior: 'smooth'
          });
          setTimeout(() => openSettings(o[3]), 350)
        }
      });
      $('probX').onclick = () => p.classList.remove('on');
      p.classList.add('on')
    }
    // insert at selection
    function insertAt(type, i) {
      libFor = {
        type,
        k: target() ? keyOf(type === 'sec' ? (chain(target()).sec || target()) : target()) : null
      };
      insert(i)
    }
    // ---------------- menus ----------------
    const devBtn = w => () => host.querySelector(`.dev[data-w="${w}"]`).click();
    const MENUS = {
      File: [
        ...(options.onSave ? [['Save', '⌘S', () => options.onSave()]] : []),
        ...(options.onRename ? [['Rename…', '', () => {
          $('fname').focus();
          $('fname').select()
        }]] : []),
        ...(options.onHistory ? [['Version history', '', () => options.onHistory()]] : []), null,
        ['Page settings…', '', pageSettings], null,
        ...(options.onOpenInBrowser ? [['Open in Sulla browser', '', () => options.onOpenInBrowser()]] : []),
        ['Download .html', '', () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([src], {
            type: 'text/html'
          }));
          a.download = fileName();
          a.click()
        }],
        ['Print / Save as PDF…', '⌘P', () => frame.contentWindow.print()],
        ...(options.onShare ? [['Share…', '', () => options.onShare()]] : []),
        ...(options.onBack ? [null, ['Close', '⌘W', () => options.onBack()]] : [])
      ],
      Edit: [
        ['Undo', '⌘Z', doUndo, () => undo.length],
        ['Redo', '⇧⌘Z', doRedo, () => redo.length], null,
        ['Duplicate', '⌘D', () => withSel(el => act('dup', el)), target],
        ['Delete', '⌫', () => withSel(el => act('del', el)), target],
        ['Move up', '', () => withSel(el => act('up', el)), target],
        ['Move down', '', () => withSel(el => act('down', el)), target], null,
        ['Copy style', '', () => withSel(el => {
          styleClip = getAttr(keyOf(el), 'style') || '';
          toast(styleClip ? 'Style copied' : 'This element has no own style')
        }), target],
        ['Paste style', '', () => withSel(el => {
          if (styleClip == null) {
            toast('Copy a style first');
            return
          }
          nextLabel = 'Paste style';
          setAttr(keyOf(el), 'style', styleClip);
          toast('Style pasted', true)
        }), () => target() && styleClip != null],
        ['Apply style to all similar', '', () => withSel(extendStyle), target], null,
        ['Find & replace…', '⌘F', openFindReplace]
      ],
      View: [
        ['Editing', 'E', () => setEditing(!editing), null, () => editing],
        ['Run like a browser (editing off)', '', () => setEditing(false), null, () => !editing], null, ['sub',
          'LAYOUT'
        ],
        ['Builder', '1', () => setView('builder'), null, () => view === 'builder'],
        ['Workbench (page + source)', '2', () => setView('workbench'), null, () => view === 'workbench'],
        ['Source code', '⌘U', toggleSource, null, () => view === 'source'], null,
        ['Wireframe', 'W', () => toggleWire(), null, () => $('wire').classList.contains('on')],
        ['Layers', 'O', () => toggleFly(), null, () => $('fly').classList.contains('on')],
        ['Focus mode', 'F', toggleFocus, null, () => rootEl.classList.contains('focus')], null, ['sub', 'DEVICE'],
        ['Desktop', '', devBtn('100%'), null, () => frame.style.width === '' || frame.style.width === '100%'],
        ['Tablet', '', devBtn('768px'), null, () => frame.style.width === '768px'],
        ['Phone', '', devBtn('390px'), null, () => frame.style.width === '390px']
      ],
      Insert: [
        ['sub', 'SECTION (after the selected one)'], ...LAYOUTS.map((l, i) => [l[0], '', () => insertAt('sec',
          i)]), null, ['sub', 'MODULE (after the selected item)'], ...MODS.map((m, i) => [m[0], '', () =>
          insertAt('mod', i)
        ]), null, ['Browse the layout library…', '', () => openLib('sec', target() && chain(target()).sec)]
      ],
      Format: [
        ['Element settings…', '⌘E', () => withSel(openSettings), target],
        ['Text & colours…', '', () => withSel(el => {
          tab = 'design';
          [...$('mTabs').children].forEach(x => x.classList.toggle('on', x.dataset.t === 'design'));
          openSettings(el)
        }), target], null,
        ['Bold', '', () => withSel(el => setStyle(keyOf(el), 'font-weight', '800')), target],
        ['Align left', '', () => withSel(el => setStyle(keyOf(el), 'text-align', 'left')), target],
        ['Align centre', '', () => withSel(el => setStyle(keyOf(el), 'text-align', 'center')), target],
        ['Align right', '', () => withSel(el => setStyle(keyOf(el), 'text-align', 'right')), target], null,
        ['Clear this element’s styles', '', () => withSel(el => {
          nextLabel = 'Clear styles';
          setAttr(keyOf(el), 'style', '');
          toast('Styles cleared', true)
        }), target], null, ['Page settings…', '', pageSettings]
      ],
      Inspect: [
        ['Inspect element', '⌘I', startPick],
        ['Show selection in source', '', () => withSel(showInSource), target], null, [
          'Check page (accessibility, links, SEO)', '', checkPage
        ],
        ['Validate HTML', '', checkPage],
        ['Run page scripts in preview', '', () => setEditing(false)], null, [
          'Layers', 'O', () => toggleFly(true)
        ],
        ['Wireframe', 'W', () => toggleWire(true)]
      ],
      Sulla: options.onAskSulla ? [
        ['Ask Sulla about the selection…', '', () => withSel(el => act('ai', el)), target]
      ] : [],
      Help: [
        ['Keyboard shortcuts', '?', showKeys],
        ['How editing works', '', () => openDlg('How editing works',
          '<div style="padding:18px;font-size:13.5px;line-height:1.6;color:var(--mu)"><p style="margin-top:0"><b style="color:var(--sec)">Blue</b> outlines are sections, <b style="color:var(--row)">green</b> are rows and <b style="color:var(--mod)">slate</b> are single items. Hover to see their tools.</p><p>Click text to type on the page. Click anything else, or the gear, for its settings.</p><p style="margin-bottom:0">Every change is written straight into landing.html as plain HTML. Nothing else in the file moves.</p></div>'
          )]
      ]
    };
    let openM = null;
    $('menus').innerHTML = Object.keys(MENUS).filter(name => name !== 'Sulla' || options.onAskSulla).map(m => `<button data-m="${m}">${m}</button>`).join('');

    // Drop separators left dangling when host-dependent items are hidden.
    const tidy = list => list.filter((it, i, a) => it || (i > 0 && i < a.length - 1 && a[i - 1] && a[i + 1]));

    function showMenu(m, anchor) {
      openM = m;
      [...$('menus').children].forEach(b => b.classList.toggle('on', b.dataset.m === m));
      const items = tidy(MENUS[m]),
        dr = $('drop'),
        anchorRect = () => (anchor || host.querySelector(`[data-m="${m}"]`)).getBoundingClientRect();
      if (!editing && LOCKED.includes(m)) {
        dr.innerHTML =
          '<div class="sub">EDITING IS OFF</div><button id="mOn"><i></i>Turn editing on<kbd>E</kbd></button>';
        $('mOn').onclick = ev => {
          ev.stopPropagation();
          closeMenu();
          setEditing(true)
        };
        const r = anchorRect();
        dr.style.left = r.left + 'px';
        dr.style.top = (r.bottom + 4) + 'px';
        dr.classList.add('on');
        return
      }
      dr.innerHTML = items.map((it, i) => !it ? '<hr>' : it[0] === 'sub' ? `<div class="sub">${it[1]}</div>` :
        `<button data-i="${i}" ${it[3]&&!it[3]()?'disabled':''}><i>${it[4]&&it[4]()?'✓':''}</i>${it[0]}${it[1]?`<kbd>${it[1]}</kbd>`:''}</button>`
        ).join('');
      dr.querySelectorAll('button').forEach(b => b.onclick = ev => {
        ev.stopPropagation();
        const it = items[+b.dataset.i];
        closeMenu();
        it[2]()
      });
      const r = anchorRect();
      dr.style.left = r.left + 'px';
      dr.style.top = (r.bottom + 4) + 'px';
      dr.classList.add('on')
    }

    function closeMenu() {
      openM = null;
      $('drop').classList.remove('on');
      [...$('menus').children].forEach(b => b.classList.remove('on'))
    }
    $('menus').onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      openM === b.dataset.m ? closeMenu() : showMenu(b.dataset.m)
    };
    $('menus').onmouseover = e => {
      const b = e.target.closest('button');
      if (b && openM && openM !== b.dataset.m) showMenu(b.dataset.m)
    };
    rootEl.addEventListener('click', e => {
      if (!e.target.closest('#drop')) closeMenu()
    });
    // init
    if (options.onRename) $('fname').value = fileName();
    else $('fname').textContent = fileName();
    $('pUrl').textContent = fileName();
    $('codeTitle').textContent = 'Source · ' + fileName();
    if ($('bHist')) $('bHist').addEventListener('click', () => setTimeout(() => {
      const all = host.querySelector('#histAll');
      if (all) all.onclick = () => {
        $('hist').classList.remove('on');
        options.onHistory();
      };
    }, 0));
    // Narrow screens: one dropdown exposes every visible menu as a section.
    $('menus').insertAdjacentHTML('beforebegin', '<button class="shb-wb-menuall" id="menuAll" title="Menu" aria-label="Menu"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>');
    $('menuAll').onclick = e => {
      e.stopPropagation();
      const dr = $('drop');
      if (dr.classList.contains('on')) {
        closeMenu();
        return;
      }
      const sections = Object.keys(MENUS).filter(m => MENUS[m].length);
      dr.innerHTML = sections.map(m => {
        const items = !editing && LOCKED.includes(m) ? [
          ['Turn editing on', 'E', () => setEditing(true)]
        ] : tidy(MENUS[m]);
        return `<div class="sub">${m}</div>` + items.map((it, i) => it ?
          `<button data-section="${m}" data-item="${i}" ${it[3]&&!it[3]()?'disabled':''}><i></i>${it[0]}<kbd>${it[1]||''}</kbd></button>` : '<hr>').join('')
      }).join('');
      dr.querySelectorAll('[data-section]').forEach(b => b.onclick = ev => {
        ev.stopPropagation();
        const m = b.dataset.section;
        const items = !editing && LOCKED.includes(m) ? [
          ['Turn editing on', 'E', () => setEditing(true)]
        ] : tidy(MENUS[m]);
        closeMenu();
        items[Number(b.dataset.item)][2]();
      });
      const r = $('menuAll').getBoundingClientRect();
      dr.style.left = r.left + 'px';
      dr.style.top = (r.bottom + 4) + 'px';
      dr.classList.add('on');
    };
    $('editTog').disabled = Boolean(options.readOnly);
    $('ta').value = src;
    renderCode();
    render();
    if (options.readOnly) setEditing(false);
    if (options.sourceEditorFactory) {
      const sourceHost = host.querySelector('.shb-dv-ed');
      sourceHost.innerHTML = '';
      externalSourceEditor = options.sourceEditorFactory(sourceHost, {
        value: src,
        readOnly: Boolean(options.readOnly || !editing),
        onChange(value) {
          setSrc(String(value), {
            merge: true,
            label: 'Source edit'
          });
        },
      });
    }

    try {
      const v = localStorage.getItem('sulla.htmlEditor.view');
      if (v) setView(v);
      if (!options.readOnly && localStorage.getItem('sulla.htmlEditor.editing') === '0') setEditing(false)
    } catch (_) {}

    if (options.onRename) $('fname').addEventListener('change', event => options.onRename(event.target.value));
    if ($('back')) $('back').onclick = () => options.onBack();

    if (!options.onAskSulla) {
      host.querySelectorAll('[data-a=ai], #askGo').forEach(el => {
        el.hidden = true;
      });
    }

    const api = {
      setSource(value) {
        src = String(value ?? '');
        $('ta').value = src;
        if (externalSourceEditor && externalSourceEditor.getValue() !== src) externalSourceEditor.setValue(src);
        renderCode();
        render();
      },
      setSaveState(value) {
        const save = $('save');
        save.classList.toggle('dirty', value !== 'saved');
        save.lastElementChild.textContent = ({
          saved: 'Saved',
          saving: 'Saving…',
          dirty: 'Not saved',
          error: 'Not saved',
          conflict: 'Conflict'
        })[value] || value;
      },
      setPeers(peers) {
        const box = host.querySelector('.shb-wb-pres');
        box.innerHTML = (Array.isArray(peers) ? peers : []).map(peer =>
          `<span title="${esc(peer.name || '')}">${esc((peer.name || '?')[0].toUpperCase())}</span>`).join('');
      },
      setReadOnly(value) {
        options.readOnly = Boolean(value);
        if (options.readOnly) setEditing(false);
        $('editTog').disabled = options.readOnly;
      },
      destroy() {
        externalSourceEditor?.destroy();
        host.innerHTML = '';
      },
    };
    api.setPeers(options.peers || []);
    api.setSaveState(options.saveState || 'saved');
    return api;
  }
  root.SullaHtmlBuilder = {
    mount,
    version: VERSION,
    _test: {
      tokenize,
      patchSource,
      sandboxFor,
      previewPolicy,
      applyCssomStyles,
      injectDocument
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
