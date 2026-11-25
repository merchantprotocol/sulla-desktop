// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import { TracePayloadSerializer } from './TracePayloadSerializer';
import { ToolPayloadRepository } from '../../services/ToolPayloadRepository';
import type { Message } from '../../models/Message';
import { asMessageId } from '../../types/chat';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn() } }));

describe('DetailedTraceProjection', () => {
  it('projects ordered rows anchored to an existing standard entry without mutating frozen messages', () => {
    // risk: shared transcript mutation and incorrect insertion order.
    const messages = Object.freeze([
      Object.freeze({ id: asMessageId('user-1'), kind: 'user', createdAt: 1, text: 'run it' }),
      Object.freeze({ id: asMessageId('thinking-1'), kind: 'thinking', createdAt: 2, thoughts: ['Searching files'], reportingActivity: 'tool', startedAt: 2, completed: true }),
      Object.freeze({ id: asMessageId('tool-1'), kind: 'tool', createdAt: 3, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'ok', input: 'echo safe' }),
      Object.freeze({ id: asMessageId('reply-1'), kind: 'sulla', createdAt: 4, text: 'done', model: 'test-model', tokens: 3 }),
    ]) as unknown as readonly Message[];
    const before = JSON.stringify(messages);
    const reporting = new TranscriptReporting();
    const standard = reporting.entries(messages, 'info');
    const [turn] = new DetailedTraceProjection().project(messages, standard);
    expect(turn.anchorEntryId).toBe('reply-1');
    expect(turn.rows.map(row => row.kind)).toEqual(['thought', 'tool']);
    expect(turn.rows.every(row => row.anchorEntryId === 'reply-1')).toBe(true);
    expect(turn.usage).toMatchObject({ model: 'test-model', totalTokens: 3 });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('shows complete tool name, input, output, and error without redaction', () => {
    // risk: trace fidelity and operator debugging; raw values must remain inspectable.
    const messages = [
      { id: asMessageId('user-secret'), kind: 'user', createdAt: 1, text: 'inspect' },
      { id: asMessageId('tool-secret'), kind: 'tool', tool: 'Vault', recordedToolName: 'vault/read', desc: 'command', status: 'error', input: 'Authorization: Bearer FAKE', output: 'vault output', error: 'vault error', createdAt: 2 },
      { id: asMessageId('reply-secret'), kind: 'sulla', createdAt: 3, text: 'done' },
    ] satisfies Message[];
    const [turn] = new DetailedTraceProjection().project(messages, new TranscriptReporting().entries(messages, 'info'));
    expect(turn.rows[0]).toMatchObject({ target: 'vault/read', keyArgs: 'Authorization: Bearer FAKE' });
    expect(turn.rows[0].payload!.serialize()).toContain('Bearer FAKE');
    expect(turn.rows[0].payload!.serialize()).toContain('vault output');
    expect(turn.rows[0].payload!.serialize()).toContain('vault error');
  });

  it('loads the durable full tool event through its pointer when the Detailed payload expands', async() => {
    // risk: data loss — expanding a compacted row must retrieve the complete durable event by thread and tool id.
    const result = `COMPLETE_OUTPUT:${ 'x'.repeat(5_000) }:END`;
    const invoke = vi.fn(async(_channel: string, reference: { threadId: string; toolRunId: string }) => ({
      success: true,
      data: { type: 'tool_call', toolCallId: reference.toolRunId, result },
    }));
    const repository = new ToolPayloadRepository({ invoke } as any);
    const messages: Message[] = [
      { id: asMessageId('pointer-user'), kind: 'user', createdAt: 1, text: 'inspect' },
      { id: asMessageId('pointer-tool'), kind: 'tool', createdAt: 2, tool: 'Exec', recordedToolName: 'exec', status: 'ok', toolPayloadRef: { threadId: 'thread-pointer', toolRunId: 'run-pointer' } },
      { id: asMessageId('pointer-reply'), kind: 'sulla', createdAt: 3, text: 'done' },
    ];
    const [turn] = new DetailedTraceProjection(undefined, undefined, undefined, repository)
      .project(messages, new TranscriptReporting().entries(messages, 'info'));

    await expect(turn.rows[0].payload!.load!()).resolves.toMatchObject({ toolCallId: 'run-pointer', result });
    expect(invoke).toHaveBeenCalledWith('chat-messages:tool-payload', { threadId: 'thread-pointer', toolRunId: 'run-pointer' });
  });

  it('presents inline image bytes as an image resource, never as visible base64 text', () => {
    // risk: image visibility — screenshots must render as images while remaining non-text payloads in the expanded trace.
    const image = 'SYNTHETIC_IMAGE_BYTES';
    const presentation = new TracePayloadSerializer().present({ screenshotBase64: image, screenshotMediaType: 'image/png' });

    expect(presentation.images).toEqual([{ src: `data:image/png;base64,${ image }`, alt: 'Tool image 1' }]);
    expect(presentation.text).toContain('[Image reference 1]');
    expect(presentation.text).not.toContain(image);
  });
});
