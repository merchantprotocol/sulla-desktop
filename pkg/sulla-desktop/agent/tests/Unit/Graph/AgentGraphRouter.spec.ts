// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentGraphRouter } from '../../../nodes/AgentGraphRouter';

// risk: a whole chat turn failed with "Agent error: Cannot set properties of
// undefined (setting 'status')" when the AgentGraph edge defaulted a turn to
// DONE on a thread whose metadata.agent was missing (Graph.ts wrote
// `metadata.agent.status = 'done'` with no guard).
describe('AgentGraphRouter', () => {
  const router = new AgentGraphRouter();

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('ends the turn and records DONE when metadata.agent is missing, instead of throwing', () => {
    const state = { metadata: { cycleComplete: false } as any };

    expect(() => router.route(state)).not.toThrow();
    expect(router.route({ metadata: {} })).toBe('end');

    expect(state.metadata.agent).toEqual({ status: 'done' });
    expect(state.metadata.cycleComplete).toBe(true);
  });

  it('keeps the existing agent config when it defaults an unknown status to DONE', () => {
    const state = { metadata: { agent: { provider: 'claude-code', model: 'claude-opus-5-5', status: 'in_progress' } } as any };

    expect(router.route(state)).toBe('end');

    expect(state.metadata.agent).toEqual({ provider: 'claude-code', model: 'claude-opus-5-5', status: 'done' });
    expect(state.metadata.cycleComplete).toBe(true);
  });

  it('ends on explicit DONE and BLOCKED without touching cycle state', () => {
    for (const status of ['done', 'BLOCKED']) {
      const state = { metadata: { agent: { status }, cycleComplete: false } as any };
      expect(router.route(state)).toBe('end');
      expect(state.metadata.cycleComplete).toBe(false);
    }
  });

  it('loops on CONTINUE and counts the cycle', () => {
    const state = { metadata: { agent: { status: 'continue' }, agentLoopCount: 2 } as any };

    expect(router.route(state)).toBe('agent');
    expect(state.metadata.agentLoopCount).toBe(3);
  });

  it('treats tool calls without a wrapper as one implicit continue and consumes the flag', () => {
    const state = { metadata: { agent: { status: 'in_progress' }, hadToolCalls: true } as any };

    expect(router.route(state)).toBe('agent');
    expect(state.metadata.hadToolCalls).toBe(false);
    // The consumed flag must not loop forever: the next pass defaults to DONE.
    expect(router.route(state)).toBe('end');
  });

  it('pauses for a running workflow unless this is a playbook reentry', () => {
    const running = { status: 'running' };
    expect(router.route({ metadata: { activeWorkflow: running, agent: { status: 'continue' } } })).toBe('end');
    expect(router.route({ metadata: { activeWorkflow: running, _isPlaybookReentry: true, agent: { status: 'continue' } } })).toBe('agent');
  });
});
