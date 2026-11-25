// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  find: vi.fn(),
  resolve: vi.fn(),
  legacyResolve: vi.fn(),
  applierStart: vi.fn(),
}));

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => true, getAllWindows: () => [] } }));
vi.mock('@pkg/agent/services/DecisionService', () => ({ decisionService: { subscribe: vi.fn(() => () => undefined), find: harness.find, resolve: harness.resolve } }));
vi.mock('@pkg/agent/tools/toolRuntime', () => ({ toolRuntime: { start: vi.fn() } }));
vi.mock('@pkg/agent/services/DecisionExpirySweeper', () => ({ DecisionExpirySweeper: class { start() { /* expiry is covered by its own spec */ } } }));
vi.mock('@pkg/agent/tools', () => ({ toolRegistry: { getCategories: () => [], getToolNamesForCategory: () => [], getToolDescription: () => '' } }));
vi.mock('@pkg/agent/services/ApprovalService', () => ({ ApprovalService: { getInstance: () => ({ resolve: harness.legacyResolve }) } }));
vi.mock('@pkg/main/ipcMain', () => ({ getIpcMainProxy: () => ({ handle: (name: string, handler: (...args: any[]) => any) => harness.handlers.set(name, handler) }) }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { error: vi.fn() } } }));
vi.mock('@pkg/main/FilesPublishDecisionApplier', () => ({ FilesPublishDecisionApplier: class { start() { harness.applierStart() } } }));

import { initSullaApprovalEvents } from '@pkg/main/sullaApprovalEvents';

describe('approval:resolve legacy IPC guard', () => {
  beforeEach(() => {
    harness.handlers.clear();
    vi.clearAllMocks();
    harness.find.mockResolvedValue({ id: 'decision-1', kind: 'approval', conversationId: 'child-thread' });
    harness.resolve.mockResolvedValue({ settled: true });
    harness.legacyResolve.mockReturnValue(true);
    initSullaApprovalEvents();
  });

  const event = () => {
    const mainFrame = { url: 'file:///application/index.html' };
    return { sender: { mainFrame }, senderFrame: mainFrame } as any;
  };

  it('refuses every persisted decision id and directs callers to decisions:resolve', async() => {
    // risk: authorization — the transcript-facing legacy IPC must not settle a durable approval by id alone.
    const handler = harness.handlers.get('approval:resolve')!;

    await expect(handler(event(), { approvalId: 'decision-1', decision: 'approved' })).rejects.toThrow('Use decisions:resolve');
    expect(harness.resolve).not.toHaveBeenCalled();
    expect(harness.legacyResolve).not.toHaveBeenCalled();
  });

  it('retains the legacy path only when the id is not a durable decision', async() => {
    harness.find.mockResolvedValue(undefined);

    await expect(harness.handlers.get('approval:resolve')!(event(), { approvalId: 'legacy-id', decision: 'denied' })).resolves.toEqual({ settled: true });
    expect(harness.legacyResolve).toHaveBeenCalledWith('legacy-id', 'denied', undefined);
  });
});
