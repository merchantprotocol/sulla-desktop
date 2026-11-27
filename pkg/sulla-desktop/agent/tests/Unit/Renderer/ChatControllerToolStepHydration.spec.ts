// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { asMessageId } from '@pkg/pages/chat/types/chat';
import type { Message } from '@pkg/pages/chat/models/Message';

describe('ChatController tool-step hydration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps live and legacy running cards unchanged through hydrate, history merge, and serialization', () => {
    // risk: correctness — renderer reload must not persist a fabricated failure while the backend run is live.
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
    controller.mergeCanonicalHistory([{ ...tool, status: 'error', error: 'stale canonical status' }]);

    expect(controller.messages.value.map(message => message.kind === 'tool' ? message.status : null)).toEqual(['running', 'running', 'running']);
    expect((controller.messages.value[0] as Extract<Message, { kind: 'tool' }>).meta).toEqual(tool.meta);
    expect((controller.messages.value[1] as Extract<Message, { kind: 'tool' }>).meta).toBe('94ms');
    expect((controller.messages.value[2] as Extract<Message, { kind: 'tool' }>).meta).toEqual(endedTool.meta);
    expect(controller.serialize().thread.messages.map(message => message.kind === 'tool' ? message.status : null)).toEqual(['running', 'running', 'running']);
    expect((controller.serialize().thread.messages[0] as Extract<Message, { kind: 'tool' }>).meta).toEqual(tool.meta);
    controller.dispose();
  });

  it('settles running cards only when the backend run is known idle', () => {
    // risk: correctness — stale rows must stop ticking after a confirmed idle state, including legacy rows.
    const source = new ChatController();
    const state = source.serialize();
    source.dispose();
    const startedAt = 1_000;
    const tool = {
      id: asMessageId('tool-running'), kind: 'tool', createdAt: startedAt, tool: 'Bash', recordedToolName: 'exec',
      desc: 'Running command', status: 'running', input: '{"command":"git status"}',
      meta: { step: { stepId: 'step-1', runId: 'run-1', provider: 'codex', source: 'codex_cli', safeLabel: 'git', startedAt } },
    } satisfies Message;
    const legacyTool = {
      id: asMessageId('tool-legacy'), kind: 'tool', createdAt: startedAt, tool: 'Bash', recordedToolName: 'exec',
      desc: 'Running command', status: 'running', meta: '94ms',
    } satisfies Message;
    const endedTool = {
      id: asMessageId('tool-ended'), kind: 'tool', createdAt: startedAt, tool: 'Bash', recordedToolName: 'exec',
      desc: 'Running command', status: 'running',
      meta: { step: { stepId: 'step-ended', runId: 'run-1', provider: 'codex', source: 'codex_cli', safeLabel: 'git',
        startedAt, endedAt: 3_000, durationMs: 2_000, ok: true } },
    } satisfies Message;
    const controller = new ChatController();
    vi.spyOn(Date, 'now').mockReturnValue(5_000);

    controller.hydrate({ ...state, thread: { ...state.thread, messages: [tool, legacyTool, endedTool] } });
    controller.settleInterruptedToolSteps();

    expect(controller.messages.value).toMatchObject([
      { status: 'error', error: 'Interrupted after app restart.', meta: { step: { startedAt, endedAt: 5_000, durationMs: 4_000, ok: false } } },
      { status: 'error', error: 'Interrupted after app restart.', meta: '94ms' },
      { status: 'ok', meta: { step: { endedAt: 3_000, durationMs: 2_000, ok: true } } },
    ]);
    expect(controller.serialize().thread.messages).toMatchObject([
      { status: 'error', error: 'Interrupted after app restart.' },
      { status: 'error', error: 'Interrupted after app restart.' },
      { status: 'ok', meta: { step: { ok: true } } },
    ]);
    controller.dispose();
  });
});
