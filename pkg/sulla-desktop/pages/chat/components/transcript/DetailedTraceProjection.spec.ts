// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import { ChatController } from '../../controller/ChatController';
import { asMessageId } from '../../types/chat';
import type { Message } from '../../models/Message';

describe('DetailedTraceProjection', () => {
  it('groups safe activity, tool details and usage into one turn metadata line', () => {
    // risk: trace accuracy — data from distinct pipeline events must stay on one user turn.
    const messages: Message[] = [
      { id: asMessageId('user_1700000000000_a'), kind: 'user', createdAt: 1_700_000_000_000, text: 'Check this.' },
      { id: asMessageId('1700000000001_thinking'), kind: 'thinking', createdAt: 1_700_000_000_001, thoughts: ['Searching files'], reportingActivity: 'tool', startedAt: 1_700_000_000_001, completed: true },
      { id: asMessageId('1700000000002_tool_call'), kind: 'tool', createdAt: 1_700_000_000_002, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'ok', output: 'clean', durationMs: 120 },
      { id: asMessageId('1700000000004_reply'), kind: 'sulla', createdAt: 1_700_000_000_004, text: 'Done.', replyAttribution: { agent: 'Sulla', model: 'test-model' } },
    ];
    const reporting = new TranscriptReporting();
    const projection = new DetailedTraceProjection();

    const turns = projection.project(messages, reporting.entries(messages, 'debug'), [{
      afterId: messages[0].id, threadId: 'thread-1', runId: 'run-1', nodeId: 'agent-node',
      receivedAt: 1_700_000_000_003, inputTokens: 80, outputTokens: 12, durationMs: 900, model: 'test-model',
    }], reporting.entries(messages, 'info'), new Map([[messages[2].id, { args: { command: 'git status', cwd: '/repo' } }]]), 'thread-1');
    expect(turns).toHaveLength(1);
    const [turn] = turns;

    expect(turn.afterId).toBe(messages[0].id);
    expect(turn.rows.map(row => row.kind)).toEqual(['thought', 'tool']);
    expect(turn.rows[1]).toMatchObject({ target: 'git status', toolName: 'exec', args: 'cwd=/repo', durationMs: 120, status: 'ok' });
    expect(turn.metadata).toMatchObject({ agent: 'Sulla', model: 'test-model', inputTokens: 80, outputTokens: 12, steps: 1, durationMs: 900 });
    expect(turn.metadata.startedAt).toBe(messages[0].createdAt);
  });

  it('keeps first-call usage on an otherwise tool-free turn', () => {
    // risk: trace accuracy — token_info can arrive before the assistant reply and must not be dropped.
    const messages: Message[] = [
      { id: asMessageId('user_1700000000000_empty'), kind: 'user', createdAt: 1_700_000_000_000, text: 'Say hello.' },
      { id: asMessageId('1700000000001_reply'), kind: 'sulla', createdAt: 1_700_000_000_020, text: 'Hello.' },
    ];
    const reporting = new TranscriptReporting();
    const [turn] = new DetailedTraceProjection().project(messages, reporting.entries(messages, 'debug'), [{
      afterId: messages[0].id,
      threadId: 'thread-1',
      runId: 'run-1',
      nodeId: 'agent-node',
      receivedAt: 1_700_000_000_010,
      durationMs: 120,
      inputTokens: 12,
      outputTokens: 2,
      model: 'test-model',
    }]);

    expect(turn.afterId).toBe(messages[0].id);
    expect(turn.rows).toEqual([]);
    expect(turn.metadata).toMatchObject({ agent: 'Sulla', model: 'test-model', startedAt: messages[0].createdAt, durationMs: 120, inputTokens: 12, outputTokens: 2, steps: 0 });
  });

  it('does not surface untyped private reasoning or background-browser payloads', () => {
    // risk: private reasoning — only audited public activity strings may enter the trace.
    const messages: Message[] = [
      { id: asMessageId('user_1700000000000_b'), kind: 'user', createdAt: 1_700_000_000_000, text: 'Find a page.' },
      { id: asMessageId('1700000000001_thinking'), kind: 'thinking', createdAt: 1_700_000_000_001, thoughts: ['private model scratch text'], startedAt: 1_700_000_000_001, completed: true },
      { id: asMessageId('1700000000002_tool_hidden'), kind: 'tool', createdAt: 1_700_000_000_002, tool: 'Browser', recordedToolName: 'background_browse', desc: 'Private background tab', status: 'ok', input: 'https://hidden.example' },
    ];
    const reporting = new TranscriptReporting();
    const projection = new DetailedTraceProjection();

    expect(projection.project(messages, reporting.entries(messages, 'debug'))).toEqual([]);
  });

  it('keeps failures and retries as separate rows and describes the next action', () => {
    // risk: recovery visibility — the cause and retry must not be collapsed into one event.
    const messages: Message[] = [
      { id: asMessageId('user_1700000000000_c'), kind: 'user', createdAt: 1_700_000_000_000, text: 'Run the check.' },
      { id: asMessageId('1700000000001_tool_first'), kind: 'tool', createdAt: 1_700_000_000_001, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'error', error: 'process exited with status 1' },
      { id: asMessageId('1700000000002_tool_retry'), kind: 'tool', createdAt: 1_700_000_000_002, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'ok', output: 'passed' },
    ];
    const reporting = new TranscriptReporting();
    const tracePayloads = new Map([
      [messages[1].id, { args: { command: 'pnpm test' } }],
      [messages[2].id, { args: { command: 'pnpm test' } }],
    ]);
    const [turn] = new DetailedTraceProjection().project(messages, reporting.entries(messages, 'debug'), [], undefined, tracePayloads);

    expect(turn.rows).toHaveLength(2);
    expect(turn.rows[0].note).toContain('process exited with status 1');
    expect(turn.rows[0].note).toContain('Next: Retried pnpm test');
    expect(turn.rows[1].verb).toBe('Retried');
    expect(turn.metadata.failures).toBe(1);
  });

  it('keeps a 125-step turn intact and omits unavailable usage fields', () => {
    // risk: trace integrity — large turns must not drop rows or invent missing metrics.
    const messages: Message[] = [
      { id: asMessageId('user_1700000000000_d'), kind: 'user', createdAt: 1_700_000_000_000, text: 'Inspect the project.' },
      ...Array.from({ length: 125 }, (_, index) => ({
        id: asMessageId(`${1_700_000_000_001 + index}_tool_step_${index}`),
        kind: 'tool' as const,
        createdAt: 1_700_000_000_001 + index,
        tool: 'File',
        recordedToolName: 'file_search',
        desc: 'Searching project files',
        status: 'ok' as const,
      })),
    ];
    const reporting = new TranscriptReporting();
    const [turn] = new DetailedTraceProjection().project(messages, reporting.entries(messages, 'debug'));

    expect(turn.rows).toHaveLength(125);
    expect(turn.metadata.steps).toBe(125);
    expect(turn.metadata).not.toHaveProperty('inputTokens');
    expect(turn.metadata).not.toHaveProperty('outputTokens');
  });

  it('maps early usage to the exact following user turn and never falls back by time', () => {
    // risk: usage attribution — one turn's token totals must not leak onto an adjacent turn.
    const messages: Message[] = [
      { id: asMessageId('user-first'), kind: 'user', createdAt: 1_700_000_000_000, text: 'First request' },
      { id: asMessageId('tool-first'), kind: 'tool', createdAt: 1_700_000_000_001, tool: 'Shell', desc: 'First call', status: 'ok' },
      { id: asMessageId('reply-first'), kind: 'sulla', createdAt: 1_700_000_000_002, text: 'First reply' },
      { id: asMessageId('user-next'), kind: 'user', createdAt: 1_700_000_000_003, text: 'Second request' },
      { id: asMessageId('tool-next'), kind: 'tool', createdAt: 1_700_000_000_004, tool: 'Shell', desc: 'Second call', status: 'ok' },
      { id: asMessageId('reply-next'), kind: 'sulla', createdAt: 1_700_000_000_005, text: 'Second reply' },
    ];
    const reporting = new TranscriptReporting();
    const samples = [
      { afterId: messages[0].id, threadId: 'thread-1', runId: 'run-1', nodeId: 'agent-node', receivedAt: 99_000, inputTokens: 11 },
      { afterId: messages[3].id, threadId: 'thread-1', runId: 'run-2', nodeId: 'agent-node', receivedAt: 1, inputTokens: 22 },
      { afterId: 'missing-anchor', threadId: 'thread-1', runId: 'run-orphan', nodeId: 'agent-node', receivedAt: 1_700_000_000_999, inputTokens: 999 },
      { afterId: messages[3].id, threadId: 'other-thread', runId: 'run-other', nodeId: 'agent-node', receivedAt: 1_700_000_000_999, inputTokens: 500 },
    ];

    const turns = new DetailedTraceProjection().project(
      messages, reporting.entries(messages, 'debug'), samples,
      reporting.entries(messages, 'info'), new Map(), 'thread-1',
    );

    expect(turns.map(turn => turn.id)).toEqual(['trace:user-first', 'trace:user-next']);
    expect(turns.map(turn => turn.metadata.inputTokens)).toEqual([11, 22]);
  });

  it('keeps a stable turn id when a streaming placeholder is replaced', () => {
    // risk: disclosure state — replacing the reply must not remount its open trace rail.
    const user = { id: asMessageId('stable-user'), kind: 'user', createdAt: 1, text: 'Run a check' } satisfies Message;
    const streaming = { id: asMessageId('stream-placeholder'), kind: 'streaming', createdAt: 2, text: 'Working', startedAt: 2 } satisfies Message;
    const reply = { id: asMessageId('completed-reply'), kind: 'sulla', createdAt: 3, text: 'Done' } satisfies Message;
    const reporting = new TranscriptReporting();
    const projection = new DetailedTraceProjection();
    const placeholderTurn = projection.project([user, streaming], reporting.entries([user, streaming], 'debug'))[0];
    const completedTurn = projection.project([user, reply], reporting.entries([user, reply], 'debug'))[0];

    expect(placeholderTurn.id).toBe(completedTurn.id);
    expect(completedTurn.id).toBe('trace:stable-user');
  });

  it('keeps live trace data out of saved/exported thread messages and strips legacy payloads on reload', () => {
    // risk: data integrity/privacy — renderer-only diagnostics and legacy payloads must not enter saved or synced messages.
    const controller = new ChatController();
    const message: Message = {
      id: asMessageId('tool-live-only'), kind: 'tool', createdAt: 10,
      tool: 'Shell', desc: 'Running command', status: 'ok', input: 'echo safe',
    };
    controller.appendMessage(message);
    controller.appendMessage({ ...message, id: asMessageId('tool-legacy'), traceArgs: { api_token: 'persisted-secret' } } as Message);
    const transcriptBeforeTrace = controller.messages.value.map(item => ({ ...item }));
    controller.detailedTraceUsage.value = [{
      afterId: 'user-anchor', threadId: 'backend-thread', runId: 'run-1', nodeId: 'agent-node',
      receivedAt: 10, inputTokens: 12,
    }];
    controller.setDetailedTracePayload(String(message.id), { args: { api_token: 'synthetic-secret' } });

    const snapshot = controller.serialize();
    expect(controller.messages.value).toEqual(transcriptBeforeTrace);
    expect(snapshot.thread.messages).toHaveLength(transcriptBeforeTrace.length);
    expect(snapshot.thread.messages[0]).toEqual(transcriptBeforeTrace[0]);
    expect(snapshot.thread.messages[1]).not.toHaveProperty('traceArgs');
    expect(snapshot).not.toHaveProperty('detailedTraceUsage');
    expect(snapshot).not.toHaveProperty('detailedTracePayloads');
    expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-secret|persisted-secret/);

    const reopened = new ChatController();
    reopened.hydrate({ ...snapshot, thread: { ...snapshot.thread, messages: transcriptBeforeTrace } });
    expect(reopened.messages.value[1]).not.toHaveProperty('traceArgs');
    expect(reopened.detailedTraceUsage.value).toEqual([]);
    expect(reopened.detailedTracePayloads.value.size).toBe(0);
    reopened.dispose();
    controller.dispose();
  });
});
