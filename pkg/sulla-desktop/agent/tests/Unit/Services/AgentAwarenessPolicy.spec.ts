// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentAwarenessPolicy } from '@pkg/agent/services/AgentAwarenessPolicy';

describe('AgentAwarenessPolicy', () => {
  it('hides only launch and discovery tools while retaining worker reporting tools', () => {
    // risk: workers can see sibling work or lose the tools needed to report their own result.
    const policy = new AgentAwarenessPolicy();
    const tools = ['meta/spawn_agent', 'agents/directory', 'agents_list_agents', 'check_agent_jobs', 'send_job_message', 'stop_agent_job', 'start_agent_conversation', 'send_agent_message', 'read_agent_conversation', 'close_agent_conversation', 'promote_to_tab', 'report_progress', 'return_result', 'wait', 'org/directory', 'github_get_pr'];
    const definitions = tools.map(name => ({ type: 'function', function: { name } }));
    expect(policy.filterToolNames(tools, { agent_awareness: false })).toEqual(['report_progress', 'return_result', 'wait', 'org/directory', 'github_get_pr']);
    expect(policy.filterTools(definitions, { agent_awareness: false }).map(tool => tool.function.name)).toEqual(['report_progress', 'return_result', 'wait', 'org/directory', 'github_get_pr']);
    expect(policy.filterToolNames(tools, { agent_awareness: true })).toEqual(tools);
    expect(policy.filterTools(definitions, { agent_awareness: true })).toEqual(definitions);
    expect(policy.filterToolNames(tools)).toEqual(tools);
  });

  it('blocks answer_decision when a holder has opted out of seeing other agents', () => {
    // risk: authorization — an agent with Sees other agents OFF must not act as a parent decision holder.
    const policy = new AgentAwarenessPolicy();
    for (const name of ['answer_decision', 'agents/answer_decision', 'agents_answer_decision']) {
      expect(policy.allowsTool({ agentAwareness: false }, name), name).toBe(false);
      expect(policy.allowsTool({ agentAwareness: true }, name), name).toBe(true);
    }
  });

  it('removes every past roster line from turn-context blocks without touching surrounding text', () => {
    // risk: an opt-out is ineffective if a prior turn's roster remains in CLI transcript history.
    const policy = new AgentAwarenessPolicy();
    const turn = 'agents: user-authored prose\n<turn_context>\nnow="Tue" tz=UTC\nJonathon (human): Busy\nagents: first@worker (running)\n  agents: second@worker (running)\n</turn_context>\nagents: trailing prose';
    const filteredTurn = policy.filterTurnContext(turn, { agentAwareness: false });
    expect(filteredTurn).not.toContain('first@worker');
    expect(filteredTurn).not.toContain('second@worker');
    expect(filteredTurn).toContain('agents: user-authored prose');
    expect(filteredTurn).toContain('agents: trailing prose');
  });

  it('filters historical message content and visible agent-context fields through the policy', () => {
    // risk: stale sibling context in a resumed transcript bypasses the current per-agent visibility setting.
    const policy = new AgentAwarenessPolicy();
    const messages: Array<{ role: string; content: any }> = [
      { role: 'user', content: '<turn_context>\nnow="Tue"\nagents: sibling@worker\n</turn_context>' },
      { role: 'assistant', content: [{ type: 'text', text: '<turn_context>\nagents: child@worker\n</turn_context>\nkept' }] },
    ];
    const filtered = policy.filterHistoricalMessages(messages, { agent_awareness: false });
    expect(JSON.stringify(filtered)).not.toMatch(/sibling@worker|child@worker/);
    expect(filtered[0].content).toContain('now="Tue"');
    expect(filtered[1].content[0].text).toContain('kept');
    expect(policy.filterContextFields([
      ['team_directory', 'team'], ['subagent_directory', 'children'], ['support_context', 'support'],
    ] as const, { agent_awareness: false })).toEqual([['support_context', 'support']]);
  });
});
