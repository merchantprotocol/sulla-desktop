// SPDX-License-Identifier: GPL-2.0-or-later
const { app, BrowserWindow, session, protocol, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const webpack = require('webpack');
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { secure: true, standard: true } }]);

class CameraEffectsSmoke {
  constructor() {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ce1-smoke-'));
    this.resources = path.join(this.directory, 'extraResources', 'resources', 'camera-effects');
    fs.mkdirSync(path.dirname(this.resources), { recursive: true });
    fs.cpSync(path.resolve('resources/camera-effects'), this.resources, { recursive: true });
  }

  compilePreview(ast, descriptor) {
    // Mount actual production preview SFCs, with the parent's exact assignment code
    // and prop bindings. Only unrelated window/audio/device startup is omitted.
    const compile = (name, source) => {
      const { descriptor, errors } = parse(source, { filename: name + '.vue' });
      if (errors.length) throw new Error(errors.join('\n'));
      const script = compileScript(descriptor, { id: name, inlineTemplate: true });
      fs.writeFileSync(path.join(this.directory, name + '.js'), ts.transpileModule(script.content, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    };
    for (const name of ['CaptureCanvas', 'CameraBubble', 'ContextMenu']) {
      let source = fs.readFileSync('pkg/sulla-desktop/pages/capture-studio/' + name + '.vue', 'utf8');
      if (name === 'CaptureCanvas' && process.env.CE1_PREVIEW_MUTANT === '1') {
        source = source.replace('if (fullEl) fullEl.srcObject = stream || null;', 'if (fullEl) fullEl.srcObject = props.cameraStream || null;');
      }
      compile(name, source);
    }
    let menuDefinitions = descriptor.scriptSetup.content.slice(descriptor.scriptSetup.content.indexOf('const effectsMenuRevision ='), descriptor.scriptSetup.content.indexOf('async function showAudioContextMenu'));
    if (process.env.CE1_MENU_MUTANT === '1') menuDefinitions = menuDefinitions.replace('...cameraEffectsMenu.items()', '');
    const quality = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildQualityChildren').getText(ast);
    const menuTag = descriptor.template.content.match(/<ContextMenu\b[\s\S]*?\/>/)[0];
    compile('MenuHarness', '<template><CaptureCanvas :screen-stream="mediaSources.cameraStream.value" :camera-stream="null" current-layout="camonly" :primary-source="cameraSource" :pip-source="screenSource" audio-only-sources="" @show-screen-menu="showScreenContextMenu" @show-camera-menu="showCameraContextMenu" /><CameraBubble :camera-stream="mediaSources.cameraStream.value" :recording="recording" camera-shape="circle" current-layout="pip" :pip-source="cameraSource" @show-camera-menu="showCameraContextMenu" @show-screen-menu="showScreenContextMenu" />' + menuTag + '</template><script setup lang="ts">' + `
      import { ref, computed, reactive, watch } from 'vue';
      import CaptureCanvas from './CaptureCanvas';
      import CameraBubble from './CameraBubble';
      import ContextMenu from './ContextMenu';
      import { CameraEffectsMenu } from './CameraEffectsMenu';
      import { QUALITY_PRESETS } from './useMediaSources';
      const props = defineProps<{ state: any }>();
      const { mediaSources, recording, statusMessage } = props.state;
      const captureLifecycle = { isClosing: false };
      const cameraSource = { id: 'cam', type: 'camera', name: 'Synthetic camera', on: true, isVideo: true };
      const screenSource = { id: 'screen', type: 'screen', name: 'Synthetic screen', on: true, isVideo: true };
      const showScreenContextMenu = () => { ctxMenu.title = 'Screen'; ctxMenu.items = []; ctxMenu.visible = true; };
      const ctxMenu = reactive({ visible: false, x: 0, y: 0, title: '', items: [] as any[] });
      const updateStreamAssignments = () => {};
      ` + quality + menuDefinitions + '; defineExpose({ ctxMenu, cameraContextItems });</script>');
    let wiring = descriptor.scriptSetup.content.slice(descriptor.scriptSetup.content.indexOf('const primarySource ='), descriptor.scriptSetup.content.indexOf('const totalDiskDisplay ='));
    if (process.env.CE1_ASSIGNMENT_MUTANT === '1') {
      wiring = wiring.replace('[primarySource, pipSource, mediaSources.screenStream, mediaSources.cameraStream]', 'mediaSources.cameraStream');
    }
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['autoAssign', 'selectLayout', 'swapAssignments'].includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
    const bindings = ['CaptureCanvas', 'CameraBubble'].map(name => descriptor.template.content.match(new RegExp('<' + name + '\\b[\\s\\S]*?/>'))[0]).join('\n');
    compile('PreviewHarness', '<template>' + bindings + '</template><script setup lang="ts">' + `
      import { ref, computed, watch } from 'vue';
      import CaptureCanvas from './CaptureCanvas';
      import CameraBubble from './CameraBubble';
      const props = defineProps<{ state: any }>();
      const { sources, assign, mediaSources, currentLayout } = props.state;
      const videoSources = computed(() => sources.filter((s: any) => s.isVideo && s.on));
      const captureCanvasRef = ref(null);
      const teleprompterRef = ref(null);
      const prompterEnabled = ref(false);
      const recording = ref(false);
      const cameraShape = ref('circle');
      const audioOnlySources = '';
      const showScreenContextMenu = () => {};
      const showCameraContextMenu = () => {};
      const showAudioContextMenu = () => {};
      const ipcRenderer = { invoke: async() => {} };
      const syncPrompterFull = () => {};
      ` + wiring + functions + '; defineExpose({ autoAssign, selectLayout, swapAssignments, updateStreamAssignments });</script>');
  }

  async run() {
    let code = 1;
    try {
      // Compile the ACTUAL SFC in remote CI, including script setup and template.
      const filename = 'pkg/sulla-desktop/pages/CaptureStudio.vue';
      const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
      if (errors.length) throw new Error(errors.join('\n'));
      compileScript(descriptor, { id: 'ce1-capture-studio' });
      const template = compileTemplate({ source: descriptor.template.content, filename, id: 'ce1-capture-studio' });
      if (template.errors.length) throw new Error(template.errors.join('\n'));
      // Execute the actual SFC camera.release callback through the real RPC composable.
      const ast = ts.createSourceFile(filename + '.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let releaseHandler;
      const visit = node => {
        if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "'camera.release'") releaseHandler = node.getText(ast);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      this.compilePreview(ast, descriptor);
      if (!releaseHandler) throw new Error('Actual SFC camera.release handler not found');
      fs.writeFileSync(path.join(this.directory, 'camera-bridge.js'), ts.transpileModule('export const cameraBridge = (mediaSources: any) => ({' + releaseHandler + '});', {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
      let startupGuards = ast.statements.filter(node => ts.isExpressionStatement(node) && node.getText(ast).includes('= captureLifecycle.protect(')).map(node => node.getText(ast)).join('\n');
      let sourceFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['hasNativeSystemAudio', 'enableSystemAudio', 'disableSystemAudio', 'toggleSrc'].includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
      if (process.env.CE1_STARTUP_MUTANT === '1') {
        startupGuards = '';
        sourceFunctions = sourceFunctions.replace('return captureLifecycle.track(async() => {', 'return (async() => {').replace('\n  });\n}', '\n  })();\n}');
      }
      fs.writeFileSync(path.join(this.directory, 'source-enable.js'), ts.transpileModule('export const sourceEnable = (captureLifecycle:any, mediaSources:any, audioDriver:any, speakerCapture:any, statusMessage:any, autoAssign:any, updateStreamAssignments:any, currentLayout:any, assign:any, videoSources:any, primaryStream:any) => { ' + startupGuards + sourceFunctions + '; return toggleSrc; };', {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
      // Verify shipped assets before executing any native/runtime code.
      const manifest = JSON.parse(fs.readFileSync(path.join(this.resources, 'manifest.json')));
      for (const [file, hash] of Object.entries(manifest.distributedFiles)) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(this.resources, file))).digest('hex');
        if (actual !== hash) throw new Error('Asset hash mismatch: ' + file);
      }
      for (const name of ['FrameCompositor', 'PersonInference', 'VideoEffectService', 'CameraEffectsComposition', 'CameraStreamService', 'CaptureSessionLifecycle', 'CameraEffectsMenu']) {
        let source = fs.readFileSync(path.resolve('pkg/sulla-desktop/pages/capture-studio/effects', name + '.ts'), 'utf8');
        if (name === 'FrameCompositor' && process.env.CE1_REGRESSION_MUTANT === '1') {
          source = source.replace('scene.drawImage(this.padded, -48, -48);', 'scene.drawImage(video, -24, -24, width + 48, height + 48);');
        }
        fs.writeFileSync(path.join(this.directory, name + '.js'), ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText);
      }
      for (const name of ['useMediaSources', 'useRecorder', 'useAgentBridge', 'useAudioDriver', 'useSpeakerCapture']) {
        let source = fs.readFileSync(path.resolve('pkg/sulla-desktop/pages/capture-studio/composables', name + '.ts'), 'utf8');
        source = source.replaceAll("'../effects/", "'./");
        if (name === 'useRecorder' && process.env.CE1_RECORDING_MUTANT === '1') {
          source = source.replace('new MediaRecorder(src.stream, recorderOpts)', 'new MediaRecorder(window.__ce1Raw, recorderOpts)');
        }
        fs.writeFileSync(path.join(this.directory, name + '.js'), ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText);
      }
      // Only filesystem location is substituted: real recorder, native writer, real encoded WebM.
      fs.writeFileSync(path.join(this.directory, 'paths.js'), 'exports.default = { sullaHome: ' + JSON.stringify(this.directory) + ' };');
      // Same app:// scheme + public HTML (no CSP) as the real Capture Studio.
      const html = fs.readFileSync(path.resolve('pkg/sulla-desktop/public/capture-studio.html'), 'utf8');
      fs.writeFileSync(path.join(this.directory, 'index.html'), html.replace('</body>', '<script src="renderer.js"></script></body>'));
      fs.copyFileSync(path.resolve('scripts/camera-effects-smoke-renderer.cjs'), path.join(this.directory, 'renderer.cjs'));
      fs.copyFileSync(path.resolve('scripts/camera-effects-smoke-menu.cjs'), path.join(this.directory, 'menu-smoke.js'));
      fs.copyFileSync(path.resolve('scripts/camera-effects-smoke-preview.cjs'), path.join(this.directory, 'preview-smoke.js'));
      // Bundle the real production classes with the app's electron-renderer target.
      await new Promise((resolve, reject) => webpack({
        mode: 'production', target: 'electron-renderer',
        entry: path.join(this.directory, 'renderer.cjs'),
        output: { path: this.directory, filename: 'renderer.js' },
        optimization: { minimize: false },
        resolve: { modules: [path.resolve('node_modules'), 'node_modules'], alias: { '@pkg/utils/paths': path.join(this.directory, 'paths.js') } },
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
        additionalArguments: ['--ce1-resources=' + this.resources, ...(process.env.CE1_RECORDING_MUTANT === '1' ? ['--ce1-recording-mutant'] : []), ...(process.env.CE1_REGRESSION_MUTANT === '1' ? ['--ce1-pixels-only'] : [])],
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
