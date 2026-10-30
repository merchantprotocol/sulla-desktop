/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * Origin: pkg/sulla-desktop/pages/files/editor/html-builder/html-builder.js
 * Cloud copy is vendored; edit only in sulla-desktop.
 */
(function (root) {
  'use strict';
  const VERSION = '1.0.0';
  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const RAW = new Set(['script','style']);
  const esc = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  function scanTagEnd(source, start) {
    let quote = '';
    for (let i=start;i<source.length;i++) {
      const c=source[i];
      if (quote) { if (c===quote) quote=''; else if (c==='\\') i++; }
      else if (c==='"'||c==="'") quote=c;
      else if (c==='>') return i+1;
    }
    return source.length;
  }
  function tokenize(source) {
    const roots=[], all=[], stack=[]; let i=0;
    const attach=node=>{const p=stack.at(-1);node.parent=p||null;(p?p.children:roots).push(node);all.push(node)};
    while(i<source.length){
      const lt=source.indexOf('<',i); if(lt<0) break; i=lt;
      if(source.startsWith('<!--',i)){const z=source.indexOf('-->',i+4);i=z<0?source.length:z+3;continue}
      if(source.startsWith('<![CDATA[',i)){const z=source.indexOf(']]>',i+9);i=z<0?source.length:z+3;continue}
      if(source.startsWith('<!',i)||source.startsWith('<?',i)){i=scanTagEnd(source,i+2);continue}
      const close=/^<\s*\/\s*([A-Za-z][\w:-]*)/.exec(source.slice(i));
      if(close){const end=scanTagEnd(source,i+close[0].length);const name=close[1].toLowerCase();let at=stack.length-1;while(at>=0&&stack[at].name!==name)at--;if(at>=0){const node=stack[at];node.closeStart=i;node.end=end;stack.length=at;}i=end;continue}
      const open=/^<\s*([A-Za-z][\w:-]*)/.exec(source.slice(i));if(!open){i++;continue}
      const end=scanTagEnd(source,i+open[0].length),name=open[1].toLowerCase();
      const node={name,start:i,openEnd:end,closeStart:end,end,children:[],parent:null};attach(node);
      const openText=source.slice(i,end);if(!VOID.has(name)&&!/\s*>$/.test(openText)){stack.push(node);if(RAW.has(name)){const re=new RegExp('<\\s*\\/\\s*'+name+'\\s*>','ig');re.lastIndex=end;const m=re.exec(source);if(m){node.closeStart=m.index;node.end=re.lastIndex;stack.pop();i=re.lastIndex;continue}}}i=end;
    }
    for(const node of stack){node.closeStart=source.length;node.end=source.length}
    return {roots,all};
  }
  function injectDocument(source, run, base) {
    let value=source;
    if(base){const tag=`<base href="${esc(base)}">`;const head=/<head(?:\s[^>]*)?>/i.exec(value);value=head?value.slice(0,head.index+head[0].length)+tag+value.slice(head.index+head[0].length):tag+value}
    if(run){const csp='<meta http-equiv="Content-Security-Policy" content="navigate-to \'none\'; form-action *;">';const head=/<head(?:\s[^>]*)?>/i.exec(value);value=head?value.slice(0,head.index+head[0].length)+csp+value.slice(head.index+head[0].length):csp+value}
    return value;
  }
  function sandboxFor(run){return run?'allow-scripts allow-forms allow-popups allow-modals':'allow-same-origin'}

  function mount(host, options={}) {
    if(!host||host.nodeType!==1) throw new TypeError('SullaHtmlBuilder.mount needs a host element');
    let source=String(options.source??''), readOnly=!!options.readOnly, editing=!readOnly, saveState=options.saveState||'saved';
    let peers=Array.isArray(options.peers)?options.peers:[], view='builder', selected=null, undo=[], redo=[], sourceEditor=null, destroyed=false;
    host.innerHTML=`<div class="shb-root shb-v-builder">
      <header class="shb-bar"><button class="shb-back">‹ Files</button><input class="shb-name" aria-label="File name"><span class="shb-save"><i></i><span></span></span><nav class="shb-menus"></nav><span class="shb-spacer"></span><label class="shb-edit"><span>Editing</span><input type="checkbox"></label><div class="shb-views"><button data-view="builder">Builder</button><button data-view="workbench">Workbench</button></div><button class="shb-source" title="Source code">⌘U</button><div class="shb-devices"><button data-width="100%">Desktop</button><button data-width="768px">Tablet</button><button data-width="390px">Phone</button></div><button class="shb-undo" title="Undo">↶</button><button class="shb-redo" title="Redo">↷</button><button class="shb-history" title="History">◴</button><div class="shb-peers"></div><button class="shb-focus" title="Focus mode">⌗</button></header>
      <div class="shb-browser"><button class="shb-reload">↻</button><div class="shb-location"></div><b>Scripts running · sandboxed</b><button class="shb-open">Open in browser</button></div>
      <main class="shb-work"><section class="shb-code"><div class="shb-code-head"><b>Source</b><button class="shb-code-close">×</button></div><div class="shb-source-host"></div></section><div class="shb-divider"></div><section class="shb-stage"><iframe class="shb-frame" title="HTML page"></iframe><div class="shb-outline"><span></span><button data-act="up">↑</button><button data-act="down">↓</button><button data-act="settings">⚙</button><button data-act="duplicate">⧉</button><button data-act="ask">Sulla</button><button data-act="delete">×</button></div><button class="shb-add">＋</button></section></main>
      <div class="shb-dock"><button data-cmd="layers">Layers</button><button data-cmd="wire">Wireframe</button><button data-cmd="check">Page check</button><button data-cmd="save" class="shb-primary">Save</button></div>
      <aside class="shb-panel"><header><b>Element settings</b><button>×</button></header><div class="shb-tabs"><button>Content</button><button>Design</button><button>Advanced</button></div><div class="shb-panel-body"></div></aside><div class="shb-dialog"></div><div class="shb-toast"></div></div>`;
    const q=s=>host.querySelector(s), qa=s=>[...host.querySelectorAll(s)], frame=q('.shb-frame'), rootEl=q('.shb-root');
    q('.shb-name').value=options.fileName||'untitled.html';
    const menuNames=['File','Edit','View','Insert','Format','Inspect','Sulla','Help'];q('.shb-menus').innerHTML=menuNames.map(x=>`<button data-menu="${x}">${x}</button>`).join('');
    const notify=()=>{options.onChange?.(source);updateSave('dirty')};
    function updateSave(value){saveState=value;const label={saved:'Saved',saving:'Saving…',dirty:'Not saved',error:'Not saved',conflict:'Conflict'}[value]||value;q('.shb-save span').textContent=label;q('.shb-save').dataset.state=value}
    function record(next,label='Edit'){if(next===source)return;undo.push({source,label});redo=[];source=next;notify();render();syncSource()}
    function patch(from,to,text,label){record(source.slice(0,from)+text+source.slice(to),label)}
    function doUndo(){const item=undo.pop();if(!item)return;redo.push({source,label:item.label});source=item.source;notify();render();syncSource()}
    function doRedo(){const item=redo.pop();if(!item)return;undo.push({source,label:item.label});source=item.source;notify();render();syncSource()}
    function nodeAtPoint(path){const tree=tokenize(source);return tree.all.find(n=>n.name===path.name&&tree.all.filter(x=>x.name===n.name).indexOf(n)===path.index)||null}
    function keyFor(el){const name=el.tagName.toLowerCase(), els=[...frame.contentDocument.getElementsByTagName(name)];return{name,index:els.indexOf(el)}}
    function render(){if(destroyed)return;frame.setAttribute('sandbox',sandboxFor(!editing));frame.srcdoc=injectDocument(source,!editing,options.assetBaseUrl);q('.shb-browser').classList.toggle('on',!editing);rootEl.classList.toggle('shb-run',!editing);q('.shb-edit input').checked=editing;q('.shb-edit input').disabled=readOnly;setTimeout(bindFrame,0)}
    function bindFrame(){const d=frame.contentDocument;if(!d||!editing)return;d.addEventListener('mouseover',e=>select(e.target,false));d.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();select(e.target,true)});d.addEventListener('contextmenu',e=>{e.preventDefault();select(e.target,true);showMenu('context',e.clientX,e.clientY)});}
    function select(el,lock){if(!el?.tagName||el===frame.contentDocument.documentElement||el===frame.contentDocument.body)return;selected=keyFor(el);const r=el.getBoundingClientRect(),fr=frame.getBoundingClientRect(),box=q('.shb-outline');box.style.cssText=`display:flex;left:${fr.left-host.getBoundingClientRect().left+r.left}px;top:${fr.top-host.getBoundingClientRect().top+r.top}px;width:${r.width}px;height:${r.height}px`;box.querySelector('span').textContent=el.tagName.toLowerCase();if(lock&&/^(P|H[1-6]|A|SPAN|LI|BUTTON|STRONG|EM)$/.test(el.tagName))startInline(el)}
    function startInline(el){if(readOnly)return;const key=keyFor(el);el.contentEditable='true';el.focus();el.addEventListener('blur',()=>{const n=nodeAtPoint(key);if(n)patch(n.openEnd,n.closeStart,el.innerHTML,'Edit text')},{once:true})}
    function act(name){const n=selected&&nodeAtPoint(selected);if(!n)return;if(name==='delete')patch(n.start,n.end,'','Delete element');else if(name==='duplicate')patch(n.end,n.end,source.slice(n.start,n.end),'Duplicate element');else if(name==='up'||name==='down'){const siblings=(n.parent?n.parent.children:tokenize(source).roots),i=siblings.indexOf(n),other=siblings[i+(name==='up'?-1:1)];if(!other)return;const a=name==='up'?other:n,b=name==='up'?n:other;patch(a.start,b.end,source.slice(b.start,b.end)+source.slice(a.end,b.start)+source.slice(a.start,a.end),'Move element')}else if(name==='settings')openSettings(n);else if(name==='ask')askSulla(n)}
    function openSettings(n){const panel=q('.shb-panel'),body=q('.shb-panel-body'),open=source.slice(n.start,n.openEnd);body.innerHTML=`<label>HTML element<textarea>${esc(source.slice(n.openEnd,n.closeStart))}</textarea></label><label>Inline style<input value="${esc((/\sstyle=(?:"([^"]*)"|'([^']*)')/.exec(open)||[]).slice(1).find(Boolean)||'')}"></label><small>Changes patch only this element's byte range.</small><button class="shb-primary">Apply</button>`;panel.classList.add('on');body.querySelector('button').onclick=()=>{let next=body.querySelector('textarea').value;patch(n.openEnd,n.closeStart,next,'Element settings');panel.classList.remove('on')}}
    async function askSulla(n){if(!options.onAskSulla)return;const instruction=prompt('What should Sulla change?');if(!instruction)return;const before=source.slice(n.start,n.end),after=await options.onAskSulla({instruction,selectionHtml:before,start:n.start,end:n.end,fileName:q('.shb-name').value});if(after==null)return;showDialog('Sulla proposal',`<div class="shb-diff"><pre>${esc(before)}</pre><pre>${esc(after)}</pre></div>`,[{label:'Discard'},{label:'Apply',primary:true,run:()=>patch(n.start,n.end,after,'Ask Sulla')}])}
    function showDialog(title,body,buttons=[]){const d=q('.shb-dialog');d.innerHTML=`<section><header><b>${esc(title)}</b><button>×</button></header>${body}<footer>${buttons.map((b,i)=>`<button data-i="${i}" class="${b.primary?'shb-primary':''}">${esc(b.label)}</button>`).join('')}</footer></section>`;d.classList.add('on');d.querySelector('header button').onclick=()=>d.classList.remove('on');d.querySelectorAll('footer button').forEach((x,i)=>x.onclick=()=>{buttons[i].run?.();d.classList.remove('on')})}
    function showMenu(name,x,y){const actions=[['Settings',()=>act('settings')],...(options.onAskSulla?[['Ask Sulla…',()=>act('ask')]]:[]),['Show in source',showSelection],['Duplicate',()=>act('duplicate')],['Delete',()=>act('delete')]];showDialog(name==='context'?'Element':'Menu',actions.map((a,i)=>`<button data-action="${i}">${a[0]}</button>`).join(''));q('.shb-dialog section').style.cssText=x!=null?`position:absolute;left:${x}px;top:${y}px`:'';q('.shb-dialog').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{actions[+b.dataset.action][1]();q('.shb-dialog').classList.remove('on')})}
    function showSelection(){setView('workbench');const n=selected&&nodeAtPoint(selected);if(n)sourceEditor?.revealRange(n.start,n.end)}
    function syncSource(){if(sourceEditor&&sourceEditor.getValue()!==source)sourceEditor.setValue(source)}
    function fallbackEditor(parent,o){const ta=document.createElement('textarea');ta.className='shb-textarea';ta.value=o.value;ta.readOnly=o.readOnly;ta.oninput=()=>o.onChange(ta.value);parent.append(ta);return{setValue(v){const a=ta.selectionStart,b=ta.selectionEnd,top=ta.scrollTop;ta.value=v;ta.setSelectionRange(Math.min(a,v.length),Math.min(b,v.length));ta.scrollTop=top},getValue(){return ta.value},revealRange(a,b){ta.focus();ta.setSelectionRange(a,b)},focus(){ta.focus()},destroy(){ta.remove()}}}
    function ensureSource(){if(sourceEditor)return;sourceEditor=(options.sourceEditorFactory||fallbackEditor)(q('.shb-source-host'),{value:source,readOnly:readOnly||!editing,onChange:v=>record(v,'Source edit')})}
    function setView(next){view=next;rootEl.classList.remove('shb-v-builder','shb-v-workbench','shb-v-source');rootEl.classList.add('shb-v-'+next);if(next!=='builder')ensureSource();qa('.shb-views button').forEach(b=>b.classList.toggle('on',b.dataset.view===next))}
    function pageSettings(){const title=(/<title>([\s\S]*?)<\/title>/i.exec(source)||[])[1]||'',lang=(/<html[^>]*\slang=["']([^"']*)/.exec(source)||[])[1]||'';showDialog('Page settings',`<label>Page title<input id="shb-title" value="${esc(title)}"></label><label>Language<input id="shb-lang" value="${esc(lang)}"></label>`,[{label:'Cancel'},{label:'Save',primary:true,run:()=>{let s=source.replace(/<title>[\s\S]*?<\/title>/i,`<title>${esc(q('#shb-title').value)}</title>`);s=s.replace(/(<html[^>]*\slang=)["'][^"']*["']/i,`$1"${esc(q('#shb-lang').value)}"`);record(s,'Page settings')}}])}
    function menu(name){const common={File:[['Save',options.onSave],['Rename…',()=>q('.shb-name').focus()],['Version history',options.onHistory],['Share…',options.onShare],['Open in Sulla browser',options.onOpenInBrowser],['Close',options.onBack]],Edit:[['Undo',doUndo],['Redo',doRedo],['Find & replace…',()=>findReplace()]],View:[['Builder',()=>setView('builder')],['Workbench',()=>setView('workbench')],['Source code',()=>setView('source')],['Focus mode',()=>rootEl.classList.toggle('shb-focus-mode')]],Insert:[['Add section',()=>insertHtml('<section><div><h2>New section</h2><p>Click to edit.</p></div></section>')],['Add module',()=>insertHtml('<p>New paragraph. Click to edit.</p>')]],Format:[['Element settings…',()=>act('settings')],['Page settings…',pageSettings]],Inspect:[['Show selection in source',showSelection],['Page check',pageCheck]],Sulla:options.onAskSulla?[['Ask Sulla about selection…',()=>act('ask')]]:[],Help:[['Keyboard shortcuts',()=>showDialog('Keyboard shortcuts','<p>⌘S Save · ⌘U Source · ⌘Z Undo · E Editing · F Focus</p>')]]};showDialog(name,common[name].filter(x=>x[1]).map((x,i)=>`<button data-action="${i}">${x[0]}</button>`).join(''));const list=common[name].filter(x=>x[1]);q('.shb-dialog').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{list[+b.dataset.action][1]();q('.shb-dialog').classList.remove('on')})}
    function insertHtml(html){const at=/<\/body\s*>/i.exec(source)?.index??source.length;patch(at,at,'\n'+html+'\n','Insert element')}
    function findReplace(){showDialog('Find & replace','<label>Find<input id="shb-find"></label><label>Replace with<input id="shb-replace"></label>',[{label:'Cancel'},{label:'Replace all',primary:true,run:()=>{const a=q('#shb-find').value;if(a)record(source.split(a).join(q('#shb-replace').value),'Find & replace')}}])}
    function pageCheck(){const d=frame.contentDocument,issues=[];if(!d.querySelector('meta[name=description]'))issues.push('Missing page description');if(d.querySelectorAll('h1').length!==1)issues.push(`Expected one H1; found ${d.querySelectorAll('h1').length}`);d.querySelectorAll('img:not([alt])').forEach(()=>issues.push('Image missing alt text'));d.querySelectorAll('a[href=""],a[href="#"],a:not([href])').forEach(()=>issues.push('Link goes nowhere'));showDialog('Page check',issues.length?`<ul>${issues.map(x=>`<li>${x}</li>`).join('')}</ul>`:'<p>No problems found.</p>')}
    q('.shb-back').onclick=()=>options.onBack?.();q('.shb-name').onchange=e=>options.onRename?.(e.target.value);q('.shb-edit input').onchange=e=>{editing=e.target.checked&&!readOnly;sourceEditor?.destroy();sourceEditor=null;render();if(view!=='builder')ensureSource()};q('.shb-reload').onclick=render;q('.shb-open').onclick=()=>options.onOpenInBrowser?.();q('.shb-open').hidden=!options.onOpenInBrowser;
    q('.shb-undo').onclick=doUndo;q('.shb-redo').onclick=doRedo;q('.shb-history').onclick=()=>options.onHistory?.();q('.shb-focus').onclick=()=>rootEl.classList.toggle('shb-focus-mode');q('.shb-source').onclick=()=>setView(view==='source'?'builder':'source');q('.shb-code-close').onclick=()=>setView('builder');q('.shb-panel header button').onclick=()=>q('.shb-panel').classList.remove('on');
    q('.shb-outline').onclick=e=>{const a=e.target.closest('[data-act]');if(a)act(a.dataset.act)};q('.shb-add').onclick=()=>insertHtml('<section><div><h2>New section</h2><p>Click to edit.</p></div></section>');q('.shb-menus').onclick=e=>{const b=e.target.closest('[data-menu]');if(b)menu(b.dataset.menu)};qa('.shb-views button').forEach(b=>b.onclick=()=>setView(b.dataset.view));qa('.shb-devices button').forEach(b=>b.onclick=()=>{frame.style.width=b.dataset.width;q('.shb-stage').classList.toggle('shb-narrow',b.dataset.width!=='100%')});q('[data-cmd=save]').onclick=()=>options.onSave?.();q('[data-cmd=check]').onclick=pageCheck;q('[data-cmd=layers]').onclick=()=>showDialog('Layers',`<ul>${tokenize(source).all.filter(x=>!['html','head','body'].includes(x.name)).map(x=>`<li>${x.name}</li>`).join('')}</ul>`);q('[data-cmd=wire]').onclick=()=>rootEl.classList.toggle('shb-wireframe');
    rootEl.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();options.onSave?.()}else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?doRedo():doUndo()}else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='u'){e.preventDefault();setView(view==='source'?'builder':'source')}else if(!e.metaKey&&!e.ctrlKey&&e.key.toLowerCase()==='f'&&!/INPUT|TEXTAREA/.test(e.target.tagName))rootEl.classList.toggle('shb-focus-mode')};
    function setPeers(next){peers=Array.isArray(next)?next:[];q('.shb-peers').innerHTML=peers.map(p=>`<span title="${esc(p.name)}">${esc((p.name||'?')[0].toUpperCase())}</span>`).join('')}
    updateSave(saveState);setPeers(peers);setView('builder');render();
    return {setSource(value){source=String(value??'');render();syncSource()},setSaveState:updateSave,setPeers,setReadOnly(value){readOnly=!!value;if(readOnly)editing=false;sourceEditor?.destroy();sourceEditor=null;render();if(view!=='builder')ensureSource()},destroy(){destroyed=true;sourceEditor?.destroy();host.innerHTML=''}};
  }
  root.SullaHtmlBuilder={mount,version:VERSION,_test:{tokenize,sandboxFor,injectDocument}};
})(typeof globalThis!=='undefined'?globalThis:window);
