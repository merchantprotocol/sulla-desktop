// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import type { Message } from '../../models/Message';
import { asMessageId } from '../../types/chat';

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
});
