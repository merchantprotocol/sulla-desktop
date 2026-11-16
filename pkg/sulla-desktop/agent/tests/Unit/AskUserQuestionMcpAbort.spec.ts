// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// MCPServerHost reaches main-process modules (first-run trace) that import Electron;
// CI installs with ELECTRON_SKIP_BINARY_DOWNLOAD, so the real package throws on load.
vi.mock('electron', () => {
  const app = { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false };

  return { default: { app }, app, ipcMain: { handle: vi.fn(), on: vi.fn() }, safeStorage: {} };
});

import { MCPServerHost } from '@pkg/main/MCPServerHost';

const decisions = vi.hoisted(() => {
  return {
    request: vi.fn((_input: unknown, _timeout: number, stop?: AbortSignal) => Promise.resolve({
      record: { id: 'q-1' },
      result: new Promise(resolve => stop?.addEventListener('abort', () => resolve({ status: 'expired', answers: [] }), { once: true })),
    })),
    expire: vi.fn(),
  };
});
vi.mock('@pkg/agent/services/DecisionService', () => ({ decisionService: decisions }));
vi.mock('@pkg/agent/tools/meta/askUserQuestionShared', async(original) => ({
  ...(await original<object>()),
  emitQuestionCardViaWs: vi.fn().mockResolvedValue(true),
}));

/** The stop signal the question tool handed the decision wait. */
async function waitSignal(): Promise<AbortSignal> {
  await vi.waitFor(() => expect(decisions.request).toHaveBeenCalledTimes(1));
  return decisions.request.mock.calls[0][2]!;
}

describe('ask_user_question over MCP', () => {
  // risk: user communication. Claude Code drops a tool call that is silent for 300 s.
  // The handler ignored that, so the question stayed open and a later answer was lost.
  beforeEach(() => decisions.request.mockClear());

  it('stops waiting, and expires the question, when the caller drops the call', async() => {
    const run = new AbortController();
    const session = { state: { metadata: { threadId: 'thread-1', wsChannel: 'sulla-desktop', options: { abort: { signal: run.signal } } } } };
    const server = (new MCPServerHost() as any).buildMcpServer(session);
    const tool = server._registeredTools.ask_user_question;
    const caller = new AbortController();

    const reply = tool.handler({ questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }], timeoutMs: 1_800_000 }, { signal: caller.signal });
    const signal = await waitSignal();
    expect(signal.aborted).toBe(false);

    caller.abort();

    expect(signal.aborted).toBe(true);
    await expect(reply).resolves.toMatchObject({ content: [{ text: expect.stringContaining('did not answer') }] });
  });

  it('still stops waiting when the run itself is stopped', async() => {
    const run = new AbortController();
    const session = { state: { metadata: { threadId: 'thread-1', wsChannel: 'sulla-desktop', options: { abort: { signal: run.signal } } } } };
    const tool = (new MCPServerHost() as any).buildMcpServer(session)._registeredTools.ask_user_question;

    const reply = tool.handler({ questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }] }, { signal: new AbortController().signal });
    const signal = await waitSignal();
    run.abort();

    expect(signal.aborted).toBe(true);
    await reply;
  });
});
