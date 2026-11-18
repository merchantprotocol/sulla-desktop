// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  interface FakeWebContents {
    isLoading: () => boolean;
    send: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  }
  interface FakeWindow {
    id: number;
    isDestroyed: () => boolean;
    webContents: FakeWebContents;
  }

  const makeWindow = (id: number): FakeWindow => ({
    id,
    isDestroyed: () => false,
    webContents: { isLoading: () => false, send: vi.fn(), once: vi.fn() },
  });

  return {
    makeWindow,
    windows:     [] as FakeWindow[],
    focused:     null as FakeWindow | null,
    lastFocused: null as FakeWindow | null,
    templates:   [] as any[],
  };
});

vi.mock('electron', () => {
  const app = {
    on:             vi.fn(),
    isPackaged:     false,
    name:           'Sulla',
    getVersion:     () => '0.0.0-test',
    showAboutPanel: vi.fn(),
  };
  const Menu = {
    buildFromTemplate: (template: unknown) => {
      state.templates.push(template);

      return template;
    },
    setApplicationMenu: vi.fn(),
  };
  class MenuItem {
    label?: string;
    submenu?: unknown;

    constructor(options: Record<string, unknown>) {
      Object.assign(this, options);
    }
  }
  const BrowserWindow = {
    fromWebContents: vi.fn(),
    getFocusedWindow: vi.fn(() => null),
    getAllWindows:    vi.fn(() => []),
  };
  const ipcMain = { on: vi.fn(), handle: vi.fn() };
  const shell = { openExternal: vi.fn() };

  return { default: { app, Menu, MenuItem, BrowserWindow, ipcMain, shell }, app, Menu, MenuItem, BrowserWindow, ipcMain, shell };
});

vi.mock('@pkg/agent/database/models/ConversationHistoryModel', () => ({ ConversationHistoryModel: {} }));
vi.mock('@pkg/main/mainEvents', () => ({
  default: { on: vi.fn(), emit: vi.fn(), invoke: vi.fn(async() => undefined) },
}));
vi.mock('@pkg/main/restartCoordinator', () => ({ requestApplicationRestart: vi.fn() }));
vi.mock('@pkg/main/update/UpdateManager', () => ({
  updateManager: { getState: () => ({ channel: 'lts' }), checkForUpdates: vi.fn() },
}));
vi.mock('@pkg/utils/logging', () => {
  const log = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  return { default: { mainmenu: log, background: log } };
});
vi.mock('@pkg/utils/instance', () => ({ loopbackOrigin: () => 'http://127.0.0.1:0' }));
vi.mock('@pkg/window', () => ({
  openDocker:      vi.fn(),
  openPreferences: vi.fn(),
  openUrlInApp:    vi.fn(),
}));
vi.mock('@pkg/window/processManager', () => ({ openProcessManager: vi.fn() }));
vi.mock('@pkg/window/supportCenter', () => ({
  initSupportCenterIpc: vi.fn(),
  openSupportCenter:    vi.fn(),
}));
// Focus rule under test: the focused agent window, else the last-focused one.
// The real registry (window/agentWindows.ts) owns how focus is tracked.
vi.mock('@pkg/window/agentWindows', () => ({
  getActiveAgentWindow: () => state.focused ?? state.lastFocused,
  ensureAgentWindow:    () => state.focused ?? state.lastFocused ?? state.windows[0],
  getAgentWindows:      () => state.windows,
  isAgentWebContents:   (wc: unknown) => state.windows.some(w => w.webContents === wc),
  newAgentWindow:       vi.fn(),
}));

import buildApplicationMenu, { sendAgentCommand } from './mainmenu';

describe('sendAgentCommand window targeting', () => {
  beforeEach(() => {
    state.windows.length = 0;
    state.focused = null;
    state.lastFocused = null;
  });

  it('sends the command to the focused agent window when two agent windows exist', () => {
    // risk: a command sent to the wrong window opens tabs in a window the user isn't looking at.
    const first = state.makeWindow(1);
    const second = state.makeWindow(2);

    state.windows.push(first, second);
    state.focused = second;
    state.lastFocused = first;

    sendAgentCommand('new-chat-tab');

    expect(second.webContents.send).toHaveBeenCalledWith('agent-command', { command: 'new-chat-tab' });
    expect(first.webContents.send).not.toHaveBeenCalled();
  });

  it('sends the command to the last-focused agent window when none is focused', () => {
    // risk: with no focus (app in background) the command must still land on the window the user used last.
    const first = state.makeWindow(1);
    const second = state.makeWindow(2);

    state.windows.push(first, second);
    state.focused = null;
    state.lastFocused = first;

    sendAgentCommand('open-tab', { mode: 'integrations' });

    expect(first.webContents.send).toHaveBeenCalledWith('agent-command', { command: 'open-tab', mode: 'integrations' });
    expect(second.webContents.send).not.toHaveBeenCalled();
  });
});

describe('File menu agent entries', () => {
  const labelsOf = (items: any[]): string[] => {
    const fileMenu = items.find(item => item.label === '&File');

    return (fileMenu?.submenu ?? []).map((entry: any) => String(entry.label ?? '').replace(/&/g, ''));
  };

  const buildMenuTemplate = (platform: NodeJS.Platform): any[] => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');

    Object.defineProperty(process, 'platform', { value: platform });
    state.templates.length = 0;
    try {
      buildApplicationMenu();
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }

    return state.templates[0];
  };

  it.each(['darwin', 'linux'] as const)('offers New Agent Tab and New Agent Window, and no Open Sulla Agent (%s)', (platform) => {
    // risk: the user's explicit requirement — multi-window needs a New Agent Window entry, and the old single-agent entry must go.
    const labels = labelsOf(buildMenuTemplate(platform));

    expect(labels).toContain('New Agent Tab');
    expect(labels).toContain('New Agent Window');
    expect(labels).not.toContain('Open Sulla Agent');
  });
});
