// SPDX-License-Identifier: GPL-2.0-or-later
/** Enforces the fixture protocol even if production callers catch an unknown invoke. */
export class StrictRendererHost {
  private readonly invokes = new Set([
    'ce1:fixture-ready', 'sulla-settings:get', 'sulla-settings:set',
    'audio-driver:get-state', 'audio-driver:start-mic', 'audio-driver:stop-mic',
    'audio-driver:set-system-input', 'audio-driver:set-mic-pcm-mode',
    'audio-driver:speaker-volume-get', 'capture-studio:get-sources',
    'capture-studio:start-tracking', 'capture-studio:stop-tracking', 'teleprompter:close',
  ]);

  constructor(private readonly ipc: typeof import('electron').ipcRenderer) {}

  install(): void {
    const invoke = this.ipc.invoke.bind(this.ipc);
    this.ipc.invoke = (channel, ...args) => {
      if (!this.invokes.has(channel)) {
        this.ipc.send('ce1:failure', 'Unknown IPC invoke: ' + channel);
        return Promise.reject(new Error('Unknown IPC invoke: ' + channel));
      }
      return invoke(channel, ...args);
    };
  }
}
