// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(async() => ({ success: false })) } }));
import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import type { Message } from '../../models/Message';
import { asMessageId } from '../../types/chat';
import { ToolPayloadRepository } from '../../services/ToolPayloadRepository';
import { TracePayloadSerializer } from './TracePayloadSerializer';
import InlineReplyBody from './InlineReplyBody.vue';
import TraceRow from './TraceRow.vue';

const a2aMarker = (card: object) => `⟦SULLA_A2A:${ Buffer.from(JSON.stringify(card)).toString('base64url') }⟧`;

describe('DetailedTraceProjection', () => {
  it('keeps peer messages out of Standard and renders their complete bodies as Detailed trace rows', () => {
    // risk: agent-to-agent messages leaking into Standard or losing/truncating content in Detailed.
    const incomingBody = `INCOMING_START:${ 'peer status and full report · '.repeat(160) }:INCOMING_END`;
    const outgoingBody = `OUTGOING_START:${ 'review this complete task · '.repeat(160) }:OUTGOING_END`;
    const markerOnlyBody = 'MARKER_ONLY_OUTGOING:full text remains visible in Detailed';
    const card = a2aMarker({ id: 'outgoing-1', to: 'coding-manager', targetId: 'job-8', body: outgoingBody, status: 'delivered' });
    const markerOnly = a2aMarker({ id: 'outgoing-2', to: 'heartbeat', body: markerOnlyBody, status: 'sent' });
    const messages = [
      { id: asMessageId('user-1'), kind: 'user', createdAt: 1, text: 'review' },
      { id: asMessageId('peer-incoming'), kind: 'channel', createdAt: 2, agent: 'Heartbeat', channel: 'heartbeat', text: incomingBody },
      { id: asMessageId('reply-1'), kind: 'sulla', createdAt: 3, text: `I delegated this review. ${card} I will share the result.` },
      { id: asMessageId('user-2'), kind: 'user', createdAt: 4, text: 'another message' },
      { id: asMessageId('reply-2'), kind: 'sulla', createdAt: 5, text: markerOnly },
    ] satisfies Message[];

    const reporting = new TranscriptReporting();
    const standard = reporting.standardEntries(messages, 'info');
    expect(standard.map(entry => entry.sourceId)).toEqual(['user-1', 'reply-1', 'user-2']);
    expect(standard.some(entry => entry.kind === 'card' && entry.message.kind === 'channel')).toBe(false);
    expect(standard.some(entry => entry.sourceId === 'reply-2')).toBe(false);

    const prose = mount(InlineReplyBody, { props: { text: messages[2]!.text, agentMessagesAsTrace: true } });
    expect(prose.text()).toContain('I delegated this review.');
    expect(prose.text()).toContain('I will share the result.');
    expect(prose.find('.a2a-inline-card').exists()).toBe(false);
    expect(prose.text()).not.toContain('SULLA_A2A');
    prose.unmount();

    const turns = new DetailedTraceProjection().project(messages, standard);
    const rows = turns.flatMap(turn => turn.rows).filter(row => row.verb === 'Received' || row.verb === 'Sent');
    expect(rows.map(row => row.verb)).toEqual(['Received', 'Sent', 'Sent']);
    expect(rows.map(row => row.note)).toEqual([incomingBody, outgoingBody, markerOnlyBody]);
    expect(rows[1]).toMatchObject({ target: 'coding-manager · job-8', keyArgs: 'delivered', status: 'ok' });

    for (const [row, body] of [[rows[0]!, incomingBody], [rows[1]!, outgoingBody], [rows[2]!, markerOnlyBody]] as const) {
      const rendered = mount(TraceRow, { props: { row } });
      expect(rendered.find('.dtr-note').text()).toBe(body);
      rendered.unmount();
    }
  });

  it.each(['brief', 'standard'] as const)('keeps channel traffic out of Standard for %s agent reporting', agentReporting => {
    // risk: a producer classification accidentally promotes agent traffic into the human-facing transcript.
    const body = `CHANNEL_START:${ 'complete peer report · '.repeat(160) }:CHANNEL_END`;
    const message = {
      id: asMessageId(`channel-${agentReporting}`), kind: 'channel', createdAt: 1,
      agent: 'Heartbeat', channel: 'heartbeat', text: body, agentReporting,
    } satisfies Message;
    const reporting = new TranscriptReporting();
    const standard = reporting.standardEntries([message], 'info');

    expect(standard).toEqual([]);
    const rows = new DetailedTraceProjection().project([message], standard).flatMap(turn => turn.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verb: 'Received', note: body });
  });

  it('preserves every pre-existing Standard item when peer-message metadata is present', () => {
    // risk: transcript regression — filtering agent messages must not alter human-facing messages, approvals, or evidence.
    const user = { id: asMessageId('standard-user'), kind: 'user', createdAt: 1, text: 'please run this' } as const;
    const reply = { id: asMessageId('standard-reply'), kind: 'sulla', createdAt: 2, text: 'I will run it.' } as const;
    const approval = { id: asMessageId('standard-approval'), kind: 'tool_approval', createdAt: 3, reason: 'Needs approval', command: 'run check', decision: 'pending' } as const;
    const citation = { id: asMessageId('standard-citation'), kind: 'citation', createdAt: 4, sources: [{ num: 1, title: 'Local report', origin: 'report.md' }] } as const;
    const baseline = [user, reply, approval, citation] satisfies Message[];
    const additions = [
      { id: asMessageId('standard-peer'), kind: 'channel', createdAt: 2.5, agent: 'Mobile', channel: 'mobile', text: 'not Standard' },
      { id: asMessageId('standard-marker-only'), kind: 'sulla', createdAt: 5, text: a2aMarker({ body: 'only trace content', to: 'Mobile' }) },
    ] satisfies Message[];

    const reporting = new TranscriptReporting();
    const before = reporting.standardEntries(baseline, 'info');
    const after = reporting.standardEntries([user, additions[0]!, reply, approval, citation, additions[1]!], 'info');
    expect(after).toEqual(before);
  });

  it('keeps a denied approval in the warning state instead of reporting a tool failure', () => {
    // risk: a user denial is mislabeled as an execution failure in Detailed.
    const denied = {
      id: asMessageId('denied-approval'), kind: 'tool_approval', createdAt: 3,
      reason: 'Requires review', command: 'run check', decision: 'denied',
    } satisfies Message;

    const rows = new DetailedTraceProjection().projectRows([denied], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'approval', status: 'denied' });
  });

  it('maps an expired approval to the failed trace state', () => {
    // risk: an expired approval renders an unstyled status outside the trace state vocabulary.
    const expired = {
      id: asMessageId('expired-approval'), kind: 'tool_approval', createdAt: 4,
      reason: 'Approval expired', command: 'run check', decision: 'timed_out',
    } satisfies Message;

    const rows = new DetailedTraceProjection().projectRows([expired], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'approval', status: 'failed' });
  });

  it('keeps raw thought whitespace in the trace row and rendered text', () => {
    // risk: collapsing or trimming an agent's exact thought changes the reasoning event shown to an engineer.
    const thought = '\nTHOUGHT_START:\n  repeated   spaces stay\nTHOUGHT_END\n';
    const message = { id: asMessageId('thought-raw'), kind: 'thinking', createdAt: 10,
      startedAt: 10, completed: true, thoughts: [thought] } satisfies Message;
    const row = new DetailedTraceProjection().projectRows([message], [])[0];
    const rendered = mount(TraceRow, { props: { row } });

    expect(row.target).toBe(thought);
    expect(rendered.find('.dtr-what').element.textContent).toBe(thought);
    rendered.unmount();
  });

  it('projects ordered per-message rows for status mapping without mutating frozen messages', () => {
    // risk: shared transcript mutation or trace rows losing their source message identity.
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
    expect(turn.rows.map(row => row.kind)).toEqual(['thought', 'tool']);
    expect(turn.rows.map(row => row.anchorEntryId)).toEqual(['thinking-1', 'tool-1']);
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

  it('retains the complete tool arguments in row data for CSS-only visual ellipsizing', () => {
    // risk: truncating a long tool call before it reaches the expandable payload or row data.
    const input = JSON.stringify({ query: 'synthetic '.repeat(100) });
    const tool = { kind: 'tool', id: 'provider-long-args', createdAt: 2, tool: 'MCP tool', recordedToolName: 'mcp__search__run',
      desc: 'Searching', status: 'ok', input, output: 'found' } as const;
    const [row] = new DetailedTraceProjection().project([tool as never], []).flatMap(turn => turn.rows);

    expect(row.keyArgs).toBe(input);
    expect(row.keyArgs).toHaveLength(input.length);
    expect(JSON.parse(row.payload!.serialize()).input).toBe(input);
  });

  it('keeps long event summaries complete in row data for CSS-only visual ellipsizing', () => {
    // risk: silently truncating recorded event details before they reach the timeline.
    const summary = 'x'.repeat(301);
    const memory = { kind: 'memory', id: 'memory-long-summary', createdAt: 2, action: 'Saved', memId: 'memory-1', summary } as const;
    const [row] = new DetailedTraceProjection().projectRows([memory as never], []);

    expect(row.keyArgs).toBe(summary);
    expect(row.keyArgs).toHaveLength(summary.length);
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
