// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const app = { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false };
  return { default: { app }, app, ipcMain: { handle: vi.fn(), on: vi.fn() }, safeStorage: {} };
});
const f = vi.hoisted(() => ({ requestQuestion: vi.fn(), emit: vi.fn() }));
vi.mock('@pkg/agent/services/DecisionService', () => ({ decisionService: { requestQuestion: f.requestQuestion } }));
vi.mock('@pkg/agent/tools/meta/askUserQuestionShared', async(original) => ({ ...(await original<object>()), emitQuestionCardViaWs: f.emit }));

import { MCPServerHost } from '@pkg/main/MCPServerHost';
function tool(metadata: Record<string, unknown> = {}, run = new AbortController()) {
  const session = { state: { metadata: { threadId: 'thread-1', wsChannel: 'sulla-desktop', options: { abort: { signal: run.signal } }, ...metadata } } };
  return (new MCPServerHost() as any).buildMcpServer(session)._registeredTools.ask_user_question;
}
const input = { questions: [{ question: 'Color?', options: [{ label: 'Blue' }] }], timeoutMs: 1_800_000 };
beforeEach(() => {
  vi.clearAllMocks();
  f.requestQuestion.mockResolvedValue({ record: { id: 'q-1' }, reused: false });
  f.emit.mockResolvedValue(true);
});
describe('persistent questions over MCP', () => {
  it('returns a receipt immediately instead of a silent thirty-minute tool wait', async() => {
    const caller = new AbortController();
    const reply = await tool().handler(input, { signal: caller.signal });
    expect(reply.content[0].text).toContain('remains open until answered or dismissed');
    expect(reply.content[0].text).toContain('q-1');
    expect(reply.content[0].text).not.toContain('proceed with your best judgment');
    expect(f.requestQuestion).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'thread-1' }), expect.any(AbortSignal));
    caller.abort();
    expect(f.requestQuestion).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledOnce();
  });
  it('keeps a delegated child session identity and allows its full-catalog exec capability', async() => {
    // risk: identity integrity — the saved question must belong to the child thread so routing selects its parent, not the root chat.
    const delegatedAsk = tool({ threadId: 'child-thread', wsChannel: 'child-channel', allowedToolNames: ['exec'] });

    const reply = await delegatedAsk.handler(input, {});

    expect(reply.isError).not.toBe(true);
    expect(f.requestQuestion).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'child-thread', channel: 'child-channel' }), expect.any(AbortSignal));
    expect(f.emit).toHaveBeenCalledWith('child-channel', 'child-thread', 'q-1', expect.any(Array));
  });
  it('still refuses a narrow background surface without ask_user_question or exec', async() => {
    // risk: permissions — parent-first questions must not expand a deliberately narrow background agent's tool surface.
    const reply = await tool({ threadId: 'restricted-thread', allowedToolNames: ['memory/recall_index_lookup'] }).handler(input, {});

    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('unavailable to this agent');
    expect(f.requestQuestion).not.toHaveBeenCalled();
  });
  it('does not create another transcript card for a repeated request', async() => {
    f.requestQuestion.mockResolvedValue({ record: { id: 'q-1' }, reused: true });
    const reply = await tool().handler(input, { signal: new AbortController().signal });
    expect(reply.content[0].text).toContain('q-1');
    expect(f.emit).not.toHaveBeenCalled();
  });
  it('keeps the durable receipt when the transient transcript notification is unavailable', async() => {
    f.emit.mockResolvedValue(false);
    expect((await tool().handler(input, {})).content[0].text).toContain('For You');
  });
  it('reports an already-saved queued answer without asking for another selection', async() => {
    f.requestQuestion.mockResolvedValue({ record: { id: 'q-1', answerDelivery: 'queued', answers: [{ question: 'Color?', selected: ['Blue'] }] }, reused: true });
    const reply = await tool().handler(input, {});
    expect(reply.content[0].text).toContain('answer is already saved and queued');
    expect(reply.content[0].text).not.toContain('User answered:');
    expect(f.emit).not.toHaveBeenCalled();
  });
});
