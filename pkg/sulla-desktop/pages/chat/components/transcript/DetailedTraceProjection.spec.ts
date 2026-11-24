// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import { asMessageId } from '../../types/chat';
import type { Message } from '../../models/Message';

describe('DetailedTraceProjection', () => {
  it('groups safe activity, tool details and usage into one turn metadata line', () => {
    // risk: trace accuracy — data from distinct pipeline events must stay on one user turn.
    const messages: Message[] = [
      { id: asMessageId('user_1700000000000_a'), kind: 'user', createdAt: 1_700_000_000_000, text: 'Check this.' },
      { id: asMessageId('1700000000001_thinking'), kind: 'thinking', createdAt: 1_700_000_000_001, thoughts: ['Searching files'], reportingActivity: 'tool', startedAt: 1_700_000_000_001, completed: true },
      { id: asMessageId('1700000000002_tool_call'), kind: 'tool', createdAt: 1_700_000_000_002, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'ok', traceArgs: { command: 'git status', cwd: '/repo' }, output: 'clean', durationMs: 120 },
      { id: asMessageId('1700000000004_reply'), kind: 'sulla', createdAt: 1_700_000_000_004, text: 'Done.', replyAttribution: { agent: 'Sulla', model: 'test-model' } },
    ];
    const reporting = new TranscriptReporting();
    const projection = new DetailedTraceProjection();

    const turns = projection.project(messages, reporting.entries(messages, 'debug'), [{
      afterId: messages[2].id, receivedAt: 1_700_000_000_003, inputTokens: 80, outputTokens: 12, durationMs: 900, model: 'test-model',
    }]);
    expect(turns).toHaveLength(1);
    const [turn] = turns;

    expect(turn.afterId).toBe(messages[0].id);
    expect(turn.rows.map(row => row.kind)).toEqual(['thought', 'tool']);
    expect(turn.rows[1]).toMatchObject({ target: 'git status', args: 'cwd=/repo', durationMs: 120, status: 'ok' });
    expect(turn.metadata).toMatchObject({ agent: 'Sulla', model: 'test-model', inputTokens: 80, outputTokens: 12, steps: 1, durationMs: 900 });
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
      { id: asMessageId('1700000000001_tool_first'), kind: 'tool', createdAt: 1_700_000_000_001, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'error', traceArgs: { command: 'pnpm test' }, error: 'process exited with status 1' },
      { id: asMessageId('1700000000002_tool_retry'), kind: 'tool', createdAt: 1_700_000_000_002, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'ok', traceArgs: { command: 'pnpm test' }, output: 'passed' },
    ];
    const reporting = new TranscriptReporting();
    const [turn] = new DetailedTraceProjection().project(messages, reporting.entries(messages, 'debug'));

    expect(turn.rows).toHaveLength(2);
    expect(turn.rows[0].note).toContain('process exited with status 1');
    expect(turn.rows[0].note).toContain('Next: Retried pnpm test');
    expect(turn.rows[1].verb).toBe('Retried');
    expect(turn.metadata.failures).toBe(1);
  });

  it('keeps a 100-step turn intact and omits unavailable usage fields', () => {
    // risk: trace integrity — large turns must not drop rows or invent missing metrics.
    const messages: Message[] = [
      { id: asMessageId('user_1700000000000_d'), kind: 'user', createdAt: 1_700_000_000_000, text: 'Inspect the project.' },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: asMessageId(`${1_700_000_000_001 + index}_tool_step_${index}`),
        kind: 'tool' as const,
        createdAt: 1_700_000_000_001 + index,
        tool: 'File',
        recordedToolName: 'file_search',
        desc: 'Searching project files',
        status: 'ok' as const,
        traceArgs: { query: `item-${index}` },
      })),
    ];
    const reporting = new TranscriptReporting();
    const [turn] = new DetailedTraceProjection().project(messages, reporting.entries(messages, 'debug'));

    expect(turn.rows).toHaveLength(100);
    expect(turn.metadata.steps).toBe(100);
    expect(turn.metadata).not.toHaveProperty('inputTokens');
    expect(turn.metadata).not.toHaveProperty('outputTokens');
  });
});
