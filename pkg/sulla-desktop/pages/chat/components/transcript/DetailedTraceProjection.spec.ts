// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import type { Message } from '../../models/Message';
import { asMessageId } from '../../types/chat';
import { ToolPayloadRepository } from '../../services/ToolPayloadRepository';
import { TracePayloadSerializer } from './TracePayloadSerializer';

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
  it('shows a shell call as Ran with its full command, tool name and exit code', () => {
    // risk: a shell step that hides the command it ran or the tool that ran it.
    const tool = { kind: 'tool', id: '1_tool_exec', createdAt: 1, recordedToolName: 'exec', tool: 'Bash', desc: 'Running command', status: 'ok',
      meta: '94ms', input: JSON.stringify({ command: 'git grep -n "overwrite" AgentSeeder.ts' }), output: 'Command failed with exit code 2:\ntwo hits' } as const;
    const [row] = new DetailedTraceProjection().project([tool as never], []).flatMap(turn => turn.rows);
    expect(row).toMatchObject({ verb: 'Ran', target: 'git grep -n "overwrite" AgentSeeder.ts', keyArgs: 'exec · exit 2', durationLabel: '94ms' });
    expect(row.payload!.serialize()).toContain('two hits');
  });
  it('reads the exit code exechost writes into its output', () => {
    // risk: a failed host command shown without the code it exited with.
    const tool = { kind: 'tool', id: '1_tool_exechost', createdAt: 1, recordedToolName: 'exechost', tool: 'Bash', desc: 'Running command', status: 'error',
      meta: '1.2s', input: JSON.stringify({ command: 'ls /missing' }), output: 'Command exited 1:\nls: /missing: No such file or directory' } as const;
    const [row] = new DetailedTraceProjection().project([tool as never], []).flatMap(turn => turn.rows);
    expect(row).toMatchObject({ verb: 'Ran', target: 'ls /missing', keyArgs: 'exechost · exit 1', status: 'failed', durationLabel: '1.2s' });
  });
  it('shows no exit code for a successful call that recorded none', () => {
    // risk: inventing an "exit 0" the tool never reported.
    const tool = { kind: 'tool', id: '1_tool_ok', createdAt: 1, recordedToolName: 'exec', tool: 'Bash', desc: 'Running command', status: 'ok',
      meta: '40ms', input: JSON.stringify({ command: 'echo hi' }), output: 'hi' } as const;
    const [row] = new DetailedTraceProjection().project([tool as never], []).flatMap(turn => turn.rows);
    expect(row).toMatchObject({ verb: 'Ran', target: 'echo hi', keyArgs: 'exec', status: 'ok' });
    expect(row.keyArgs).not.toMatch(/exit/);
  });
  it('keeps a multi-line shell command on its own lines', () => {
    // risk: a multi-line command flattened into one line that is not what ran.
    const command = 'cd /repo &&\n  git status\nprintf "a  b"';
    const tool = { kind: 'tool', id: '1_tool_multi', createdAt: 1, recordedToolName: 'exec', tool: 'Bash', desc: 'Running command', status: 'ok',
      input: JSON.stringify({ command }), output: '' } as const;
    const [row] = new DetailedTraceProjection().project([tool as never], []).flatMap(turn => turn.rows);
    expect(row.target).toBe(command);
  });

  it('shows a provider tool call with the card args and complete durable result in Detailed', async() => {
    // risk: privacy and data loss — the log may redact args and the pointer may hold the only complete result.
    const input = JSON.stringify({ file_path: '/workspace/report.txt', api_key: 'SYNTHETIC_REAL_ARGUMENT' });
    const result = `COMPLETE_OUTPUT:${ 'x'.repeat(5_000_000) }:END`;
    const invoke = vi.fn(async(_channel: string, reference: { threadId: string; toolRunId: string }) => ({
      success: true,
      data: { type: 'tool_call', toolCallId: reference.toolRunId, args: '{"api_key":"[REDACTED]"}', result },
    }));
    const repository = new ToolPayloadRepository({ invoke } as any);
    const messages = [
      { id: asMessageId('provider-user'), kind: 'user', createdAt: 1, text: 'inspect' },
      { id: asMessageId('provider-call'), kind: 'tool', createdAt: 2, tool: 'MCP tool', recordedToolName: 'mcp__files__read', desc: 'Reading report', status: 'ok', input,
        toolPayloadRef: { threadId: 'thread-provider', toolRunId: 'run-provider' }, providerTool: true },
      { id: asMessageId('provider-reply'), kind: 'sulla', createdAt: 3, text: 'done' },
    ] satisfies Message[];
    const [turn] = new DetailedTraceProjection(undefined, undefined, undefined, repository)
      .project(messages, new TranscriptReporting().entries(messages, 'info'));
    const rows = turn.rows.filter(row => row.kind === 'tool');

    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('mcp__files__read');
    expect(rows[0].payload!.serialize()).toContain('SYNTHETIC_REAL_ARGUMENT');
    const loaded = await rows[0].payload!.load!() as { input: string; output: string };
    expect(loaded.input).toBe(input);
    expect(loaded.input).not.toContain('[REDACTED]');
    expect(loaded.output).toBe(result);
    expect(loaded.output).toHaveLength(result.length);
    expect(invoke).toHaveBeenCalledWith('chat-messages:tool-payload', { threadId: 'thread-provider', toolRunId: 'run-provider' });
  });

  it('presents inline image bytes as an image resource, never as visible base64 text', () => {
    // risk: image visibility — screenshots render as images while remaining available as non-text payload data.
    const image = 'SYNTHETIC_IMAGE_BYTES';
    const presentation = new TracePayloadSerializer().present({ screenshotBase64: image, screenshotMediaType: 'image/png' });

    expect(presentation.images).toEqual([{ src: `data:image/png;base64,${ image }`, alt: 'Tool image 1' }]);
    expect(presentation.text).toContain('[Image reference 1]');
    expect(presentation.text).not.toContain(image);
  });
});
