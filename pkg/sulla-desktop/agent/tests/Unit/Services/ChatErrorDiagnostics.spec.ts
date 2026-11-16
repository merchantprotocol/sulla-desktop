// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { ChatErrorDiagnostics } from '../../../services/ChatErrorDiagnostics';

// risk: a failed chat turn logged only its message, so a one-off TypeError
// could not be traced to the code, thread or delegated job that threw it.
describe('ChatErrorDiagnostics', () => {
  it('records name, stack frames, thread and job scope for a failed turn', () => {
    let err: any;
    try {
      (undefined as any).status = 'done';
    } catch (error) {
      err = error;
    }

    const fields = new ChatErrorDiagnostics().describe(err, {
      channelId:       'sulla-desktop',
      threadId:        'thread_1',
      agentId:         'opus-worker',
      state:           { metadata: { delegatedJobId: 'agent-job-1', currentNodeId: 'agent', agent: { runLocation: 'container', provider: 'claude-code' } } },
      wakeTurnJobId:   'agent-job-2',
      wakeTurnTaskIdx: 0,
    });

    expect(fields).toMatchObject({
      name:           'TypeError',
      channelId:      'sulla-desktop',
      threadId:       'thread_1',
      agentId:        'opus-worker',
      delegatedJobId: 'agent-job-1',
      wakeTurnJobId:  'agent-job-2',
      wakeTurnTask:   0,
      runLocation:    'container',
      provider:       'claude-code',
      currentNodeId:  'agent',
    });
    expect(String(fields.message)).toContain("setting 'status'");
    const stack = fields.stack as string[];
    expect(stack[0]).toContain('TypeError');
    expect(stack.some(line => line.includes('ChatErrorDiagnostics.spec'))).toBe(true);
  });

  it('caps the stack and omits scope it does not have', () => {
    const err = new Error('boom');
    err.stack = ['Error: boom', ...Array.from({ length: 200 }, (_, i) => `    at frame${ i } (/app/file${ i }.js:1:1)`)].join('\n');

    const fields = new ChatErrorDiagnostics(500).describe(err, { channelId: 'c', threadId: 't' });

    const stack = fields.stack as string[];
    expect(stack.join('').length).toBeLessThanOrEqual(500 + '…[truncated]'.length);
    expect(stack[stack.length - 1]).toBe('…[truncated]');
    expect(fields).not.toHaveProperty('delegatedJobId');
    expect(fields).not.toHaveProperty('agentId');
  });

  it('handles a thrown non-Error value', () => {
    const fields = new ChatErrorDiagnostics().describe('plain failure', { channelId: 'c', threadId: 't' });

    expect(fields).toMatchObject({ name: 'string', message: 'plain failure', stack: [] });
  });
});
