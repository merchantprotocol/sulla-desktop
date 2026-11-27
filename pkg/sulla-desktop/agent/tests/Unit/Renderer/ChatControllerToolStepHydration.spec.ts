// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { asMessageId } from '@pkg/pages/chat/types/chat';
import type { Message } from '@pkg/pages/chat/models/Message';

describe('ChatController tool-step hydration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('settles persisted running steps as interrupted failures instead of ticking after restart', () => {
    // risk: correctness — a step without a live run must not remain permanently running after app restart.
    const source = new ChatController();
    const state = source.serialize();
    source.dispose();
    const startedAt = 1_000;
    const tool = {
      id: asMessageId('tool-running'), kind: 'tool', createdAt: startedAt, tool: 'Bash', recordedToolName: 'exec',
      desc: 'Running command', status: 'running', input: '{"command":"git status --short"}',
      meta: { step: { stepId: 'step-1', runId: 'run-1', provider: 'codex', source: 'codex_cli', safeLabel: 'git', startedAt } },
    } satisfies Message;
    const legacyTool = {
      id: asMessageId('tool-legacy'), kind: 'tool', createdAt: startedAt, tool: 'Bash', recordedToolName: 'exec',
      desc: 'Running command', status: 'running', meta: '94ms', input: '{"command":"git status"}',
    } satisfies Message;
    const endedTool = {
      id: asMessageId('tool-ended'), kind: 'tool', createdAt: startedAt, tool: 'Bash', recordedToolName: 'exec',
      desc: 'Running command', status: 'running', input: '{"command":"git status"}',
      meta: { step: { stepId: 'step-ended', runId: 'run-1', provider: 'codex', source: 'codex_cli', safeLabel: 'git',
        startedAt, endedAt: 3_000, durationMs: 2_000, ok: true } },
    } satisfies Message;
    const controller = new ChatController();
    vi.spyOn(Date, 'now').mockReturnValue(5_000);

    controller.hydrate({ ...state, thread: { ...state.thread, messages: [tool, legacyTool, endedTool] } });

    const restored = controller.messages.value;
    expect(restored[0]).toMatchObject({ status: 'error', error: 'Interrupted after app restart.',
      meta: { step: { startedAt, endedAt: 5_000, durationMs: 4_000, ok: false } } });
    expect(restored[1]).toMatchObject({ status: 'error', error: 'Interrupted after app restart.', meta: '94ms' });
    expect(restored[2]).toMatchObject({ status: 'ok', meta: { step: { endedAt: 3_000, durationMs: 2_000, ok: true } } });
    controller.dispose();
  });
});
