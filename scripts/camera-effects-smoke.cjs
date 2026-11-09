// SPDX-License-Identifier: GPL-2.0-or-later
const { app, BrowserWindow, session, protocol, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const webpack = require('webpack');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { secure: true, standard: true } }]);

class CameraEffectsSmoke {
  constructor() {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ce1-smoke-'));
    this.resources = path.join(this.directory, 'extraResources', 'resources', 'camera-effects');
    fs.mkdirSync(path.dirname(this.resources), { recursive: true });
    fs.cpSync(path.resolve('resources/camera-effects'), this.resources, { recursive: true });
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
      // Same app:// scheme + public HTML (no CSP) as the real Capture Studio.
      const html = fs.readFileSync(path.resolve('pkg/sulla-desktop/public/capture-studio.html'), 'utf8');
      fs.writeFileSync(path.join(this.directory, 'index.html'), html.replace('</body>', '<script src="renderer.js"></script></body>'));
      fs.copyFileSync(path.resolve('scripts/camera-effects-smoke-renderer.cjs'), path.join(this.directory, 'renderer.cjs'));
      // Bundle the real production classes with the app's electron-renderer target.
      await new Promise((resolve, reject) => webpack({
        mode: 'production', target: 'electron-renderer',
        entry: path.join(this.directory, 'renderer.cjs'),
        output: { path: this.directory, filename: 'renderer.js' },
        optimization: { minimize: false },
      }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
      await app.whenReady();
      protocol.handle('app', request => net.fetch(pathToFileURL(path.join(this.directory, new URL(request.url).pathname)).href));
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (!/^(app|file|blob|data):/.test(details.url)) {
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
      await this.window.loadURL('app://./index.html');
      console.log(JSON.stringify(await result));
      code = 0;
    } catch (error) {
      console.error(error);
      console.error('::error title=CE-1 renderer smoke::' + String(error.stack || error).replace(/%/g, '%25').replace(/\n/g, '%0A').replace(/\r/g, '%0D'));
    } finally {
      this.window?.destroy();
      fs.rmSync(this.directory, { recursive: true, force: true });
      app.exit(code);
    }
  }
}
new CameraEffectsSmoke().run();
