import { describe, expect, it } from 'vitest';
import { DetailedTraceProjection } from './DetailedTraceProjection';
import { TranscriptReporting } from './toolGroups';
import type { Message } from '../../models/Message';

describe('DetailedTraceProjection', () => {
  it('projects ordered rows anchored to an existing standard entry without mutating frozen messages', () => {
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
    expect(turn.rows.map(row => row.kind)).toEqual(['activity', 'thought', 'tool']);
    expect(turn.rows.every(row => row.anchorEntryId === 'reply-1')).toBe(true);
    expect(turn.usage).toMatchObject({ model: 'test-model', totalTokens: 3 });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('shows complete tool name, input, output, and error without redaction', () => {
    // risk: trace fidelity and operator debugging; raw values must remain inspectable.
    const messages = [
      { id: 'user-secret', kind: 'user', createdAt: 1, text: 'inspect' },
      { id: 'tool-secret', kind: 'tool', tool: 'Vault', recordedToolName: 'vault/read', desc: 'command', status: 'error', input: 'Authorization: Bearer FAKE', output: 'vault output', error: 'vault error', createdAt: 2 },
      { id: 'reply-secret', kind: 'sulla', createdAt: 3, text: 'done' },
    ] satisfies Message[];
    const [turn] = new DetailedTraceProjection().project(messages, new TranscriptReporting().entries(messages, 'info'));
    expect(turn.rows[0]).toMatchObject({ target: 'vault/read', keyArgs: 'Authorization: Bearer FAKE' });
    expect(turn.rows[0].rawPayload).toContain('Bearer FAKE');
    expect(turn.rows[0].rawPayload).toContain('vault output');
    expect(turn.rows[0].rawPayload).toContain('vault error');
  });
});
