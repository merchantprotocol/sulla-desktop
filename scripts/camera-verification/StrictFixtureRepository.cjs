// SPDX-License-Identifier: GPL-2.0-or-later
const { ipcMain } = require('electron');

/** In-memory repository. No fallback, backend, socket, database or production handler. */
class StrictFixtureRepository {
  constructor() {
    this.settings = new Map();
    this.audit = [];
    this.micRunning = false;
    this.modelReads = 0;
    this.failNextModel = false;
    this.handlers = new Map([
      ['ce1:model-read', () => { this.modelReads++; const fail = this.failNextModel; this.failNextModel = false; return { fail }; }],
      ['ce1:fixture-ready', () => ({ identity: 'ce1-strict-memory-v1' })],
      ['sulla-settings:get', key => {
        this.validateSetting(key); return this.settings.get(key) ?? null;
      }],
      ['sulla-settings:set', (key, value) => {
        this.validateSetting(key); this.settings.set(key, value); return true;
      }],
      ['audio-driver:get-state', () => this.state()],
      ['audio-driver:start-mic', () => { this.micRunning = true; return this.state(); }],
      ['audio-driver:stop-mic', () => { this.micRunning = false; return this.state(); }],
      ['audio-driver:set-system-input', () => true],
      ['audio-driver:set-mic-pcm-mode', () => true],
      ['audio-driver:speaker-volume-get', () => ({ ok: true, volume: 0, muted: true })],
      ['capture-studio:get-sources', () => [{ id: 'screen:synthetic', name: 'Synthetic screen', thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]],
      ['capture-studio:start-tracking', () => true],
      ['capture-studio:stop-tracking', () => true],
      ['teleprompter:close', () => true],
    ]);
    this.sends = new Set(['capture-studio:rpc-register', 'capture-studio:rpc-unregister', 'capture-studio:rpc-reply', 'capture-studio:recording-state', 'audio-driver:mic-gain', 'audio-driver:mic-mute', 'ce1:mounted', 'ce1:stale-invoked', 'ce1:closed', 'ce1:failure']);
  }

  state() { return { micRunning: this.micRunning, speakerRunning: false }; }

  validateSetting(key) {
    const keys = ['layout', 'cameraShape', 'cameraDeviceId', 'micDeviceId', 'tpFontSize', 'tpSpeed', 'tpHighlightColor', 'savePath', 'screenQuality', 'cameraQuality'];
    if (!keys.includes(String(key).replace(/^captureStudio:/, '')) || !key.startsWith('captureStudio:')) throw new Error('Unknown setting: ' + key);
  }

  install(window, fail) {
    for (const [channel, handler] of this.handlers) {
      ipcMain.handle(channel, (_event, ...args) => {
        this.audit.push({ channel, args });
        try { return handler(...args); } catch (error) { fail(error); throw error; }
      });
    }
    window.webContents.on('ipc-message', (_event, channel, ...args) => {
      this.audit.push({ channel, args });
      if (!this.sends.has(channel)) fail(new Error('Unknown IPC send: ' + channel));
    });
    window.webContents.on('console-message', (_event, level, message) => {
      // Electron rejects unregistered invokes. Treat those rejections as a failed fixture, even if callers catch them.
      if (/No handler registered|Unknown setting|ERR_CONNECTION/.test(message)) fail(new Error(message));
      console.log('[renderer]', level, message);
    });
  }
}
module.exports = { StrictFixtureRepository };
