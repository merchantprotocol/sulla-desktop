// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';
import { resolveGraphToolSurface } from '@pkg/main/graphToolSurface';

describe('AgentAwarenessPolicy', () => {
  it('hides only launch and discovery tools while retaining worker reporting tools', () => {
    // risk: workers can see sibling work or lose the tools needed to report their own result.
    const policy = new AgentAwarenessPolicy();
    const tools = ['meta/spawn_agent', 'agents/directory', 'agents_list_agents', 'check_agent_jobs', 'send_job_message', 'stop_agent_job', 'report_progress', 'return_result', 'wait', 'org/directory', 'github_get_pr'];
    expect(policy.filterToolNames(tools, { agent_awareness: false })).toEqual(['report_progress', 'return_result', 'wait', 'org/directory', 'github_get_pr']);
    expect(policy.filterToolNames(tools, { agent_awareness: true })).toEqual(tools);
    expect(policy.filterToolNames(tools)).toEqual(tools);
  });

  it('filters the graph-stamped CLI tool surface, not just API schemas', () => {
    // risk: CLI workers bypass BaseNode schema filtering and still see agent-launch tools.
    expect(resolveGraphToolSurface({
      agentAwareness: false,
      allowedToolNames: ['agents_spawn_agent', 'agents_directory', 'agents_report_progress', 'agents_return_result', 'agents_wait'],
    })).toEqual(['agents_report_progress', 'agents_return_result', 'agents_wait']);
    expect(resolveGraphToolSurface({ agentAwareness: true, allowedToolNames: ['agents_directory'] })).toEqual(['agents_directory']);
  });

  it('removes past roster lines and runtime agent-network text without touching other context', () => {
    // risk: an opt-out is ineffective if a prior turn's roster remains in CLI transcript history.
    const policy = new AgentAwarenessPolicy();
    const turn = '<turn_context>\nnow="Tue" tz=UTC\nJonathon (human): Busy\nagents: sibling@worker (running)\n</turn_context>';
    expect(policy.filterTurnContext(turn, { agentAwareness: false })).not.toContain('agents:');
    const runtime = policy.filterRuntimeContext([
      '- You are part of a live multi-agent network — Heartbeat and other agents are active',
      '- Keep the task in scope',
    ], { agentAwareness: false });
    expect(runtime.join('\n')).not.toContain('multi-agent network');
    expect(runtime.join('\n')).toContain('Keep the task in scope');
  });
});
