// SPDX-License-Identifier: GPL-2.0-or-later
const fs = require('node:fs');
const path = require('node:path');

/** Trusted native pointer input; executeJavaScript is restricted to observations/oracles. */
class Driver {
  constructor(window, directory, repository) { this.window = window; this.directory = directory; this.repository = repository; this.screenshots = []; }
  async read(code) { return this.window.webContents.executeJavaScript(code); }
  assert(value, message) { if (!value) throw new Error(message); }

  async ready(expression, message) {
    // Bounded in-renderer frame readiness, not a job-status poll/wait loop.
    return this.read(`new Promise((resolve,reject)=>{ const end=performance.now()+20000; const frame=()=>{ try { if (${expression}) return resolve(true); if(performance.now()>end) return reject(new Error(${JSON.stringify(message)})); requestAnimationFrame(frame); } catch(e){ reject(e); } }; frame(); })`);
  }

  async target(selector, text) {
    return this.read(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(el=>el.getBoundingClientRect().width&&el.getBoundingClientRect().height).find(el=>${text ? `el.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if(!el) throw new Error('Missing pointer target: '+${JSON.stringify(selector + ' ' + (text || ''))}); const r=el.getBoundingClientRect(); if(!r.width||!r.height)throw new Error('Hidden pointer target'); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  }

  async pointer(selector, text, button = 'left', hover = false) {
    const point = await this.target(selector, text);
    this.window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    if (!hover) {
      this.window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1 });
      this.window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1 });
    }
    await this.read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }

  async screenshot(name) {
    const image = await this.window.webContents.capturePage();
    const bytes = image.toPNG(); const size = image.getSize();
    this.assert(bytes.length > 1000 && size.width > 0 && size.height > 0, 'Empty screenshot');
    fs.writeFileSync(path.join(this.directory, name + '.png'), bytes);
    this.screenshots.push({ name, bytes: bytes.length, ...size });
  }

  async outside() {
    this.window.webContents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 });
    this.window.webContents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
    await this.ready('!document.querySelector(".ctx-menu-backdrop")', 'Menu did not close');
  }

  async menu(selector = 'video', locked = false) {
    await this.pointer(selector, null, 'right');
    try {
      await this.ready('document.querySelector("[data-menu-id=effect-framing]")', 'MENU_REACHABILITY_SENTINEL: actual parent video menu unreachable');
    } catch (error) {
      await this.screenshot('menu-failure').catch(() => {});
      const summary = await this.read(`JSON.stringify({videos:[...document.querySelectorAll('video')].map(v=>({cls:v.parentElement&&v.parentElement.className,w:v.videoWidth,r:v.getBoundingClientRect().toJSON()})),menus:[...document.querySelectorAll('[class*=ctx-menu]')].map(e=>e.className),ids:[...document.querySelectorAll('[data-menu-id]')].map(e=>e.dataset.menuId),toast:document.querySelector('.status-toast')?.textContent,focused:document.hasFocus()})`).catch(e => String(e));
      throw new Error(error.message + ' ' + selector + ' ' + summary);
    }
    if (!locked) await this.ready('!document.querySelector("[data-menu-id=effect-framing]").disabled', 'Camera effects never settled');
  }

  async strength(label, key, value) {
    await this.menu();
    await this.pointer('.ctx-menu-has-sub', label, 'left', true);
    await this.ready(`document.querySelector('[data-menu-id="${key}-${value}"]')`, 'Strength flyout missing');
    await this.pointer(`[data-menu-id="${key}-${value}"]`);
  }

  async run() {
    await this.ready('!document.querySelector(".loading-screen")', 'Actual parent never completed boot');
    await this.screenshot('01-boot');
    // Parent auto-enabled the synthetic mic. Disable it through its real control before video-only recording.
    await this.pointer('.src-toggle[title="Microphone"]');
    await this.pointer('.src-toggle[title="Camera"]');
    await this.ready('[...document.querySelectorAll("video")].some(v=>v.videoWidth>0&&v.readyState>=2)', 'No presented synthetic camera frame');
    await this.menu();
    this.assert(await this.read('!document.querySelector("[data-menu-id=effect-framing]").classList.contains("active")'), 'Effects not OFF by default');
    this.assert(this.repository.modelReads === 0, 'OFF defaults loaded a model');
    await this.screenshot('02-default-off');
    await this.pointer('[data-menu-id=effect-framing]');
    await this.ready('!document.querySelector(".ctx-menu-backdrop")', 'Menu did not close');
    for (const value of [0.15, 0.2, 0.35, 0.5, 0.75, 1, 0, 0.35]) await this.strength('Appearance softening', 'soften', value);
    for (const value of [0.15, 0.2, 0.35, 0.5, 0.75, 1]) await this.strength('Light background blur', 'backgroundBlur', value);
    await this.ready(`(()=>{const v=[...document.querySelectorAll('video')].find(v=>v.videoWidth&&v.getBoundingClientRect().width);if(!v)return false;const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const x=c.getContext('2d');x.drawImage(v,0,0);return Math.abs(x.getImageData(52,180,1,1).data[0]-x.getImageData(60,180,1,1).data[0])<100;})()`, 'Preview transformation sentinel did not appear');
    await this.screenshot('03-effects-enabled');
    await this.menu();
    this.assert(await this.read('document.querySelector("[data-menu-id=effect-framing]").classList.contains("active")'), 'Framing not enabled');
    // Close via existing backdrop, then record through the real parent control.
    await this.outside();
    await this.pointer('.record-pill');
    await this.ready('document.querySelector(".record-pill.active")', 'Parent recording failed');
    await this.menu('video', true);
    this.assert(await this.read('document.querySelector("[data-menu-id=effect-framing]").disabled'), 'Recording did not lock effects');
    await this.screenshot('04-record-lock');
    this.window.webContents.send('ce1:stale-action');
    await this.ready('document.querySelector(".status-toast")?.textContent.includes("Stop recording")', 'Stale menu action escaped recording lock');
    await this.read('new Promise(resolve=>{let n=0;const tick=()=>++n>=90?resolve():requestAnimationFrame(tick);tick();})');
    await this.outside();
    await this.pointer('.record-pill');
    await this.ready('document.querySelector(".recording-toast")', 'Parent did not finish saved recording');
    await this.screenshot('05-saved');
    await this.strength('Light background blur', 'backgroundBlur', 0);
    await this.strength('Appearance softening', 'soften', 0);
    await this.menu();
    await this.pointer('[data-menu-id=effect-framing]');
    await this.screenshot('06-off');
    await this.pointer('.src-toggle[title="Screen"]');
    await this.pointer('.layout-btn', 'PiP');
    await this.ready('document.querySelector(".cam-bubble video")?.videoWidth > 0', 'PiP camera missing');
    await this.menu('.cam-bubble video'); await this.screenshot('06b-pip'); await this.outside();
    await this.pointer('.screen-preview video', null, 'right');
    await this.ready('document.querySelector(".ctx-menu-backdrop")', 'Screen context menu missing');
    this.assert(await this.read('!document.querySelector("[data-menu-id=effect-framing]")'), 'Camera effects leaked into screen menu');
    await this.outside();
    await this.pointer('.layout-btn', 'Side by Side');
    await this.menu('.sbs-camera video'); await this.screenshot('06c-side-by-side'); await this.outside();
    await this.pointer('.src-toggle[title="Screen"]');
    await this.pointer('.layout-btn', 'Camera Only');
    this.repository.failNextModel = true;
    await this.menu();
    await this.pointer('[data-menu-id=effect-framing]');
    await this.ready('document.querySelector(".status-toast")?.textContent.includes("Original camera video")', 'Initialization fallback status missing');
    await this.screenshot('07-fallback');
    await this.menu();
    this.assert(await this.read('!document.querySelector("[data-menu-id=effect-framing]").classList.contains("active")'), 'Failure left active state');
    await this.pointer('[data-menu-id=effect-framing]');
    await this.menu();
    await this.ready('document.querySelector("[data-menu-id=effect-framing]")?.classList.contains("active")', 'Failure retry did not recover');
    await this.screenshot('08-retry');
    await this.outside();
    return { screenshots: this.screenshots };
  }
}
module.exports = { Driver };
