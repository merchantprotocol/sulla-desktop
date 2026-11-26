// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { BrowserTab } from '@pkg/composables/useBrowserTabs';
import type { WorkspaceTabRequest } from '@pkg/shared/workspaceTabRequest';
import { InternalTabViewManager } from '@pkg/window/internalTabViewManager';

const { sendSync, boot } = vi.hoisted(() => ({
  sendSync: vi.fn(),
  boot: vi.fn<(sender: Electron.WebContents, url: string) => Promise<BrowserTab | undefined>>(),
}));
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: { sendSync, on: vi.fn(), send: vi.fn(), invoke: vi.fn().mockResolvedValue([]) },
}));
vi.mock('electron', () => ({
  default: { app: { isPackaged: false } },
  WebContentsView: class {
    hostedTab?: Promise<BrowserTab | undefined>;
    webContents = {
      on: vi.fn(),
      loadURL: (url: string) => { this.hostedTab = boot(this.webContents as unknown as Electron.WebContents, url); },
    };
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  history.replaceState(null, '', '/');
  vi.useRealTimers();
});

const files = (fileId?: string): WorkspaceTabRequest => ({
  mode: 'files', title: 'File Manager',
  ...(fileId ? { filesNavigation: { fileId, path: fileId + '.png', section: 'detail' as const } } : {}),
});

async function openInShell(shell: typeof import('@pkg/composables/useBrowserTabs'), request: WorkspaceTabRequest) {
  const navigate = vi.fn<(event: Event) => void>();
  window.addEventListener('sulla:navigate-tab', navigate, { once: true });
  await shell.openWorkspaceTab(request);
  const event = navigate.mock.calls[0][0] as CustomEvent<{ tabId: string }>;
  return shell.useBrowserTabs().getTab(event.detail.tabId)!;
}

it('shows B in the attached Files renderer after returning to chat from A', async () => {
  const shell = await import('@pkg/composables/useBrowserTabs');
  const manager = new InternalTabViewManager();
  const attach = vi.fn<(view: { hostedTab: Promise<BrowserTab | undefined> }) => void>();
  const owner = {
    id: 1, once: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() },
    contentView: { addChildView: attach, removeChildView: vi.fn() },
  } as unknown as Electron.BrowserWindow;
  manager.markChromeReady(owner);

  // Electron starts an independent renderer on loadURL, not on every activation.
  boot.mockImplementation(async (sender, url) => {
    history.replaceState(null, '', new URL(url).search);
    try {
      sendSync.mockImplementation((_channel, id) => structuredClone(manager.descriptorFor(sender, id)));
      vi.resetModules();
      const host = await import('@pkg/composables/useBrowserTabs');
      return host.useBrowserTabs().getTab(new URL(url).searchParams.get('tabId')!);
    } finally {
      history.replaceState(null, '', '/');
    }
  });

  async function showFile(fileId: string) {
    const tab = await openInShell(shell, files(fileId));
    manager.activate(owner, tab.id, 'main', { x: 0, y: 0, width: 200, height: 100 }, JSON.parse(JSON.stringify(tab)));
    return (await attach.mock.lastCall![0].hostedTab)!;
  }

  const first = await showFile('A');
  expect(first.filesNavigation?.fileId).toBe('A');
  manager.setVisible(owner, first.id, false); // Back to chat; the Files renderer stays alive.
  expect((await showFile('B')).filesNavigation?.fileId).toBe('B');
});

it('focuses the existing Files tab for a bare Open Files request', async () => {
  const shell = await import('@pkg/composables/useBrowserTabs');
  const first = await openInShell(shell, files('A'));
  expect((await openInShell(shell, files())).id).toBe(first.id);
});
