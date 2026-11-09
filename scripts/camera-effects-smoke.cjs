// SPDX-License-Identifier: GPL-2.0-or-later
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

class CameraEffectsSmoke {
  constructor() {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ce1-smoke-'));
    this.resources = path.resolve('resources/camera-effects');
  }

  async run() {
    let code = 1;
    try {
      // Verify shipped assets before executing any native/runtime code.
      const manifest = JSON.parse(fs.readFileSync(path.join(this.resources, 'manifest.json')));
      for (const [file, hash] of Object.entries(manifest.distributedFiles)) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(this.resources, file))).digest('hex');
        if (actual !== hash) throw new Error('Asset hash mismatch: ' + file);
      }
      for (const name of ['FrameCompositor', 'PersonInference']) {
        let source = fs.readFileSync(path.resolve('pkg/sulla-desktop/pages/capture-studio/effects', name + '.ts'), 'utf8');
        if (name === 'FrameCompositor' && process.env.CE1_REGRESSION_MUTANT === '1') {
          source = source.replace('scene.drawImage(this.padded, -48, -48);', 'scene.drawImage(video, -24, -24, width + 48, height + 48);');
        }
        fs.writeFileSync(path.join(this.directory, name + '.js'), ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText);
      }
      // Capture Studio's public HTML has no CSP. This stricter offline policy still allows
      // its native require + WASM path, but forbids network, inline scripts and uploads.
      fs.writeFileSync(path.join(this.directory, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src file:; img-src 'self' blob: data:; media-src blob:"><script src="renderer.cjs"></script>`);
      fs.copyFileSync(path.resolve('scripts/camera-effects-smoke-renderer.cjs'), path.join(this.directory, 'renderer.cjs'));
      await app.whenReady();
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (!/^(file|blob|data):/.test(details.url)) {
          console.error('Unexpected network request: ' + new URL(details.url).protocol);
          callback({ cancel: true });
          app.exit(1);
        } else callback({});
      });
      // Matches openCaptureStudio preferences; no real camera/device permission is granted.
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.window = new BrowserWindow({ show: false, webPreferences: {
        nodeIntegration: true, contextIsolation: false, webSecurity: false, backgroundThrottling: false,
        additionalArguments: ['--ce1-resources=' + this.resources, ...(process.env.CE1_REGRESSION_MUTANT === '1' ? ['--ce1-pixels-only'] : [])],
      } });
      this.window.webContents.on('console-message', (_event, _level, message) => console.log(message));
      this.window.webContents.on('render-process-gone', (_event, details) => { console.error(details); app.exit(1); });
      const result = new Promise((resolve, reject) => {
        const { ipcMain } = require('electron');
        ipcMain.once('ce1-result', (_event, result) => result.ok ? resolve(result) : reject(new Error(result.error)));
      });
      await this.window.loadFile(path.join(this.directory, 'index.html'));
      console.log(JSON.stringify(await result));
      code = 0;
    } catch (error) {
      console.error(error);
    } finally {
      this.window?.destroy();
      fs.rmSync(this.directory, { recursive: true, force: true });
      app.exit(code);
    }
  }
}
new CameraEffectsSmoke().run();
