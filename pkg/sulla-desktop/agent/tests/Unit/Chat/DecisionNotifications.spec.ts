// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, it, vi } from 'vitest';

import type { DecisionRecord } from '@pkg/shared/decisions';
import { initSullaApprovalEvents } from '@pkg/main/sullaApprovalEvents';

const f = vi.hoisted(() => ({
  subscribe: vi.fn(),
  allWindows: vi.fn(),
  allContents: vi.fn(),
  trustedSender: vi.fn(),
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: f.allWindows },
  webContents: { getAllWebContents: f.allContents },
}));
vi.mock('@pkg/agent/services/DecisionService', () => ({ decisionService: { subscribe: f.subscribe } }));
vi.mock('@pkg/agent/services/ApprovalService', () => ({ ApprovalService: {} }));
vi.mock('@pkg/agent/tools', () => ({ toolRegistry: {} }));
vi.mock('@pkg/main/ipcMain', () => ({ getIpcMainProxy: () => ({ handle: f.handle }) }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { debug: vi.fn() } } }));
vi.mock('@pkg/window/agentWindowTrust', () => ({ isAgentWindowSender: f.trustedSender }));

function renderer(url: string, destroyed = false) {
  return { getURL: () => url, isDestroyed: () => destroyed, send: vi.fn() };
}

it('notifies registered hosted chats and standalone app windows without sending cards to browser tabs', () => {
  const standalone = renderer('app://./agent.html');
  const hosted = renderer('app://./agent.html?tabHost=1&tabId=known');
  const unregistered = renderer('app://./agent.html?tabHost=1&tabId=unknown');
  const external = renderer('https://example.com/?tabHost=1');
  const disposed = renderer('app://./agent.html?tabHost=1&tabId=closed', true);
  const closing = renderer('app://./agent.html?tabHost=1&tabId=closing');
  closing.send.mockImplementation(() => { throw new Error('closed during notify') });
  f.allWindows.mockReturnValue([{ webContents: standalone, isDestroyed: () => false }]);
  f.allContents.mockReturnValue([standalone, closing, hosted, unregistered, external, disposed]);
  f.trustedSender.mockImplementation(contents => [hosted, disposed, closing].includes(contents));
  initSullaApprovalEvents();

  const record: DecisionRecord = { id: 'q', conversationId: 'thread', kind: 'question', title: 'Choose a test option', status: 'pending', channel: 'desktop', createdAt: 10, expiresAt: 30 };
  f.subscribe.mock.calls[0][0](record);

  expect(standalone.send).toHaveBeenCalledExactlyOnceWith('decisions:changed', record);
  expect(hosted.send).toHaveBeenCalledExactlyOnceWith('decisions:changed', record);
  expect(unregistered.send).not.toHaveBeenCalled();
  expect(external.send).not.toHaveBeenCalled();
  expect(disposed.send).not.toHaveBeenCalled();
});
