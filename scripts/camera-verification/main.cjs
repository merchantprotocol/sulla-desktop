// SPDX-License-Identifier: GPL-2.0-or-later
const { app, BrowserWindow, session, protocol, net, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { StrictFixtureRepository } = require('./StrictFixtureRepository.cjs');
const { Driver } = require('./Driver.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

class ActualParentVerification {
  static FONT_STYLESHEET = 'https://fonts.googleapis.com/css2?';

  constructor() {
    this.directory = path.resolve('artifacts/ce1');
    this.runtime = path.join(this.directory, 'runtime');
    this.home = path.join(this.directory, 'runtime-home');
    this.audit = { networkDenied: [], permissionsDenied: [], fixture: 'ce1-strict-memory-v1' };
    this.repository = new StrictFixtureRepository();
    fs.mkdirSync(this.home, { recursive: true });
    // All locations are established before app ready or importing any app module.
    process.env.HOME = this.home;
    process.env.XDG_CONFIG_HOME = path.join(this.home, 'config');
    process.env.XDG_CACHE_HOME = path.join(this.home, 'cache');
    app.setPath('home', this.home);
    app.setPath('userData', path.join(this.home, 'profile'));
    app.setPath('sessionData', path.join(this.home, 'session'));
    this.metadata = { sourceSha: process.env.CE1_EXPECTED_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, electron: process.versions.electron, platform: process.platform, arch: process.arch, fixture: this.audit.fixture, executedEntry: 'scripts/camera-verification/entry.ts', actualParent: 'pkg/sulla-desktop/pages/CaptureStudio.vue', excluded: ['production background/bootstrap', 'personal window context', 'shared store/plugins', 'native audio drivers', 'signing/packaging/release', 'real devices/macOS permissions/quality/FPS'] };
  }

  fail(error) { this.failure ||= error; }

  async decode(driver) {
    const captures = path.join(this.home, 'captures');
    const sessions = fs.readdirSync(captures);
    if (sessions.length !== 1) throw new Error('Expected one actual parent recording');
    const filename = path.join(captures, sessions[0], 'camera.webm');
    const bytes = fs.readFileSync(filename);
    if (bytes.length < 1000) throw new Error('Empty actual parent WebM');
    fs.copyFileSync(filename, path.join(this.directory, 'camera.webm'));
    const result = await driver.read(`(async()=>{
      const bytes=require('fs').readFileSync(${JSON.stringify(filename)});
      const url=URL.createObjectURL(new Blob([bytes],{type:'video/webm'}));
      const video=document.createElement('video');video.muted=true;video.src=url;document.body.appendChild(video);
      const presented=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Saved frame never presented')),15000);video.requestVideoFrameCallback(()=>{clearTimeout(timeout);resolve();});});
      await video.play();await presented;
      const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const at=(x,y)=>Array.from(pixels.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+4));
      const a=at(Math.round(canvas.width*0.08125),Math.round(canvas.height*0.5));
      const b=at(Math.round(canvas.width*0.09375),Math.round(canvas.height*0.5));
      const png=canvas.toDataURL('image/png');
      video.pause();video.remove();URL.revokeObjectURL(url);
      return {width:canvas.width,height:canvas.height,a,b,png};
    })()`);
    if (result.width <= 0 || result.height <= 0 || result.a[3] !== 255 || result.b[3] !== 255) throw new Error('Invalid decoded dimensions/alpha');
    // Raw synthetic stripes differ by 255. Real background blur must remove that contrast.
    if (Math.abs(result.a[0] - result.b[0]) >= 100) throw new Error('RAW_LEAK_SENTINEL: saved synthetic stripe contrast was not transformed');
    fs.writeFileSync(path.join(this.directory, 'decoded.png'), Buffer.from(result.png.split(',')[1], 'base64'));
    delete result.png;
    return { ...result, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }

  async run() {
    let code = 1;
    try {
      await app.whenReady();
      protocol.handle('app', request => {
        const filename = path.resolve(this.runtime, '.' + new URL(request.url).pathname);
        if (!filename.startsWith(this.runtime + path.sep)) throw new Error('Resource escape');
        if (!fs.existsSync(filename)) { this.audit.missingResources = [...(this.audit.missingResources || []), new URL(request.url).pathname]; return new Response('missing', { status: 404 }); }
        const type = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json' }[path.extname(filename)];
        return net.fetch(pathToFileURL(filename).href).then(response => type ? new Response(response.body, { status: response.status, headers: { 'content-type': type } }) : response);
      });
      session.defaultSession.protocol.handle('https', request => {
        if (request.url.startsWith(ActualParentVerification.FONT_STYLESHEET)) {
          this.audit.fontStylesheetStubbed = true;
          return new Response('/* offline fixture: no remote font */', { headers: { 'content-type': 'text/css' } });
        }
        this.audit.networkDenied.push(request.url);
        return new Response('denied', { status: 403 });
      });
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        // The shipped stylesheet @imports a Google font; answer it with an empty in-process stylesheet (no network).
        const allowed = /^(app|blob|data|file):/.test(details.url) || details.url.startsWith(ActualParentVerification.FONT_STYLESHEET);
        if (!allowed) this.audit.networkDenied.push(details.url);
        callback({ cancel: !allowed });
      });
      session.defaultSession.setPermissionCheckHandler((_contents, permission) => { this.audit.permissionsDenied.push(permission); return false; });
      session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => { this.audit.permissionsDenied.push(permission); callback(false); });
      this.window = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: {
        // Exact existing Capture Studio renderer preferences; no production settings are edited.
        nodeIntegration: true, contextIsolation: false, webSecurity: false, backgroundThrottling: false,
      } });
      this.repository.install(this.window, error => this.fail(error));
      const mounted = new Promise((resolve, reject) => {
        ipcMain.once('ce1:mounted', resolve);
        ipcMain.on('ce1:failure', (_event, message) => { this.fail(new Error(message)); reject(this.failure); });
        this.window.webContents.on('render-process-gone', (_event, details) => reject(new Error(JSON.stringify(details))));
      });
      await this.window.loadURL('app://./capture-studio.html');
      await mounted;
      const driver = new Driver(this.window, this.directory, this.repository);
      this.metadata.interactions = await driver.run();
      this.metadata.decode = await this.decode(driver);
      const closed = new Promise(resolve => ipcMain.once('ce1:closed', resolve));
      this.window.webContents.send('ce1:close'); await closed;
      if (this.failure) throw this.failure;
      code = 0;
    } catch (error) {
      this.metadata.error = String(error.stack || error);
      const cssDir = path.join(this.runtime, 'css');
      const diagnostics = JSON.stringify({ missing: this.audit.missingResources, denied: this.audit.networkDenied, css: fs.existsSync(cssDir) ? fs.readdirSync(cssDir) : 'no css dir', root: fs.existsSync(this.runtime) ? fs.readdirSync(this.runtime) : 'no runtime dir' });
      console.error('::error title=CE1 actual parent::' + (this.metadata.error + '\n' + diagnostics).replace(/\n/g, '%0A'));
    } finally {
      this.metadata.bundles = fs.existsSync(this.runtime) ? this.inventory(this.runtime) : [];
      fs.writeFileSync(path.join(this.directory, 'runtime-metadata.json'), JSON.stringify(this.metadata, null, 2));
      fs.writeFileSync(path.join(this.directory, 'audit.json'), JSON.stringify({ ...this.audit, ipc: this.repository.audit }, null, 2));
      this.window?.destroy(); app.exit(code);
    }
  }

  inventory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? this.inventory(filename) : [{ file: path.relative(this.directory, filename), bytes: fs.statSync(filename).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }];
    });
  }
}
new ActualParentVerification().run();
