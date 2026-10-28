/** @jest-environment node */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';

import { graphMessages, uiMessages, uiState } from './fixtures/threadMessages';

jest.unstable_mockModule('../../PostgresClient', () => ({ postgresClient: {} }));

const { threadStateToRows, stripMessages, roleForKind } = await import('../ConversationThreadStore');

const ALL_KINDS = [
  'user', 'sulla', 'streaming', 'thinking', 'tool', 'tool_approval', 'tool_question', 'patch', 'channel',
  'subagent', 'subagent_exchange', 'citation', 'memory', 'proactive', 'heartbeat', 'tts', 'interim', 'error', 'html',
];

describe('threadStateToRows (UI messages)', () => {
  const msgs = uiMessages();
  const rows = threadStateToRows('t_abc', uiState('t_abc', msgs));
  const byKind = (k: string) => rows.filter(r => r.kind === k);

  it('covers every message kind in Message.ts', () => {
    expect(new Set(rows.map(r => r.kind))).toEqual(new Set(ALL_KINDS));
  });

  it('keeps the original message verbatim in payload, ordered by position', () => {
    expect(rows).toHaveLength(msgs.length);
    rows.forEach((r, i) => {
      expect(r.position).toBe(i);
      expect(r.payload).toBe(msgs[i]);
      expect(r.id).toBe(`t_abc:${ msgs[i].id }`);
      expect(r.created_ms).toBe(msgs[i].createdAt);
    });
  });

  it('maps kind to role', () => {
    const expected: Record<string, string> = {
      user:              'user',
      sulla:             'assistant',
      streaming:         'assistant',
      html:              'assistant',
      proactive:         'assistant',
      thinking:          'assistant',
      tool:              'tool',
      tool_approval:     'system',
      tool_question:     'system',
      patch:             'system',
      channel:           'system',
      subagent:          'system',
      subagent_exchange: 'system',
      citation:          'system',
      memory:            'system',
      heartbeat:         'system',
      tts:               'system',
      interim:           'system',
      error:             'system',
    };
    for (const r of rows) expect(r.role).toBe(expected[r.kind]);
    expect(roleForKind('some_future_kind')).toBe('system');
  });

  it('derives plain-text content from text / desc / thoughts', () => {
    expect(byKind('user')[0].content).toBe('Grep the repo for GuestBridge');
    expect(byKind('thinking')[0].content).toBe('Looking for files\nFound two');
    expect(byKind('subagent')[0].content).toBe('Reading files');
    expect(byKind('citation')[0].content).toBe('');
    expect(byKind('html')[0].content).toBe('');
  });

  it('fills tool columns for kind tool', () => {
    const [ok, err] = byKind('tool');
    expect(ok).toMatchObject({
      role:         'tool',
      tool_name:    'Grep',
      tool_call_id: 'm03',
      content:      'Search GuestBridge',
      status:       'ok',
      tool_calls:   [{ id: 'm03', name: 'Grep', arguments: '{"pattern":"GuestBridge"}' }],
      tool_result:  { status: 'ok', output: 'a.ts:1\nb.ts:2', error: null, meta: '8 hits · 120ms' },
    });
    expect(err.tool_result).toEqual({ status: 'error', output: null, error: 'exit 1', meta: null });
    for (const r of rows.filter(x => x.kind !== 'tool')) {
      expect(r.tool_calls).toBeNull();
      expect(r.tool_result).toBeNull();
    }
  });

  it('carries turnId and model', () => {
    expect(byKind('user')[0].turn_id).toBe('turn1');
    expect(byKind('memory')[0].turn_id).toBeNull();
    expect(byKind('sulla')[0].model).toBe('opus-4.7');
  });

  it('disambiguates repeated message ids instead of dropping them', () => {
    const dup = threadStateToRows('t', { thread: { id: 't', messages: [{ id: 'x', kind: 'user', text: 'a' }, { id: 'x', kind: 'user', text: 'b' }] } });
    expect(dup.map(r => r.id)).toEqual(['t:x', 't:x~1']);
  });

  it('tolerates empty / malformed state', () => {
    expect(threadStateToRows('t', null)).toEqual([]);
    expect(threadStateToRows('t', { thread: { id: 't', messages: undefined as any } })).toEqual([]);
    const rows2 = threadStateToRows('t', { thread: { id: 't', messages: [null, { id: 'a', kind: 'user', text: 'hi', createdAt: 'nope' }] } });
    expect(rows2).toHaveLength(1);
    expect(rows2[0].position).toBe(1);
    expect(rows2[0].created_ms).toBeNull();
  });
});

describe('threadStateToRows (graph-format messages)', () => {
  const msgs = graphMessages();
  const rows = threadStateToRows('g1', { thread: { id: 'g1', messages: msgs } });

  it('maps role to kind and keeps payload', () => {
    expect(rows.map(r => r.kind)).toEqual(['system', 'user', 'sulla', 'tool', 'sulla']);
    expect(rows.map(r => r.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(rows.map(r => r.id)).toEqual(['g1:i0', 'g1:i1', 'g1:i2', 'g1:i3', 'g1:gm5']);
    rows.forEach((r, i) => expect(r.payload).toBe(msgs[i]));
  });

  it('keeps tool_calls / tool_call_id / name and flattens content parts', () => {
    expect(rows[2].tool_calls).toEqual(msgs[2].tool_calls);
    expect(rows[3]).toMatchObject({ tool_call_id: 'call_1', tool_name: 'exec', content: 'file1\nfile2' });
    expect(rows[4].content).toBe('Done.\nTwo files.');
  });
});

describe('stripMessages', () => {
  it('empties thread.messages and keeps everything else', () => {
    const s = uiState('t1');
    const stripped = stripMessages(s);
    expect(stripped.thread.messages).toEqual([]);
    expect({ ...stripped, thread: { ...stripped.thread, messages: s.thread.messages } }).toEqual(s);
    expect(s.thread.messages.length).toBeGreaterThan(0); // input not mutated
  });
});
