// SPDX-License-Identifier: GPL-2.0-or-later

type Listener = (...args: never[]) => void;

/** Isolated preview transport. No calls can reach Electron, services or real user data. */
class PreviewIpcRenderer {
  constructor(private readonly replies: Readonly<Record<string, () => unknown>>) {}

  async invoke(channel: string): Promise<unknown> {
    return Object.hasOwn(this.replies, channel) ? this.replies[channel]() : null;
  }

  send(): void {}
  sendSync(): void {}
  // No runtime events are emitted in the preview.
  on(_channel: string, _listener: Listener): this { return this }
  once(_channel: string, _listener: Listener): this { return this }
  removeListener(_channel: string, _listener: Listener): this { return this }
  off(_channel: string, _listener: Listener): this { return this }
  removeAllListeners(_channel?: string): this { return this }
}

export const ipcRenderer = new PreviewIpcRenderer({
  'conversation-history:get-recent': () => [],
  'chat-messages:load': () => ({ success: true, data: null }),
  'chat-messages:save': () => ({ success: true }),
  'chat-artifacts:list': () => [],
  'decisions:list': () => [],
  'decisions:conversation': () => [],
  'decisions:transcript': () => [],
  'agent-definitions:list': () => [],
  'model-provider:get-providers': () => [],
  'model-provider:get-models': () => [],
});
export const shell = { openExternal: async() => undefined };
export const clipboard = { writeText: (_text: string) => undefined };
export const webUtils = { getPathForFile: (_file: File) => '' };
