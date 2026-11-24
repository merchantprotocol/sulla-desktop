// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import type { Message } from '../../models/Message';

describe('DetailedTraceProjection', () => {
  it('projects ordered rows anchored before the reply without mutating frozen messages', () => {
    // risk: shared transcript mutation and incorrect insertion order.
    const messages = Object.freeze([
      Object.freeze({ id: 'user-1', kind: 'user', createdAt: 1, text: 'run it' }),
      Object.freeze({ id: 'thinking-1', kind: 'thinking', createdAt: 2, thoughts: ['Searching files'], reportingActivity: 'tool', startedAt: 2, completed: true }),
      Object.freeze({ id: 'tool-1', kind: 'tool', createdAt: 3, tool: 'Shell', recordedToolName: 'exec', desc: 'Running command', status: 'ok', input: 'echo safe' }),
      Object.freeze({ id: 'reply-1', kind: 'sulla', createdAt: 4, text: 'done', model: 'test-model', tokens: 3 }),
    ]) as unknown as readonly Message[];
    const before = JSON.stringify(messages);
    const reporting = new TranscriptReporting();
    const standard = reporting.entries(messages, 'info');
    const [turn] = new DetailedTraceProjection().project(messages, standard);
    expect(turn.anchorEntryId).toBe('reply-1');
    expect(turn.rows.map(row => row.kind)).toEqual(['activity', 'tool']);
    expect(turn.rows.every(row => row.anchorEntryId === 'reply-1')).toBe(true);
    expect(turn.usage).toMatchObject({ model: 'test-model', totalTokens: 3 });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('withholds shell output and command args when the command reads secrets', () => {
    // risk: secret disclosure — tool output must never expose env or credential files.
    const messages = [
      { id: 'user-secret', kind: 'user', createdAt: 1, text: 'inspect' },
      { id: 'tool-secret', kind: 'tool', createdAt: 2, tool: 'exec', recordedToolName: 'exec', desc: 'command', status: 'ok', input: 'cat ~/.aws/credentials' },
      { id: 'reply-secret', kind: 'sulla', createdAt: 3, text: 'done' },
    ] satisfies Message[];
    const [turn] = new DetailedTraceProjection().project(messages, new TranscriptReporting().entries(messages, 'info'));
    expect(turn.rows[0]).toMatchObject({ rawPayload: 'Details withheld' });
    expect(turn.rows[0]).not.toHaveProperty('keyArgs');
  });

  it('withholds denylisted tool fields and redacts model and payload strings', () => {
    // risk: secrets in tool names, errors, args, and disclosure payloads.
    const messages = [
      { id: 'user-2', kind: 'user', createdAt: 1, text: 'read it' },
      { id: 'tool-2', kind: 'tool', createdAt: 2, tool: 'Vault', recordedToolName: 'vault/read', desc: 'Bearer secret', status: 'error', input: 'password=hunter2', error: 'Bearer abc' },
      { id: 'reply-2', kind: 'sulla', createdAt: 3, text: 'done', replyAttribution: { model: 'sk-live-abcdefghi' } },
    ] satisfies Message[];
    const standard = new TranscriptReporting().entries(messages, 'info');
    const [turn] = new DetailedTraceProjection().project(messages, standard);
    expect(turn.rows[0]).toMatchObject({ target: 'Details withheld', rawPayload: 'Details withheld' });
    expect(turn.rows[0]).not.toHaveProperty('keyArgs');
    expect(turn.usage?.model).not.toContain('sk-live');
  });
});
