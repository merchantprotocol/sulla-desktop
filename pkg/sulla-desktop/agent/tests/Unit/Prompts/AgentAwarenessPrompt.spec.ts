// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

const f = vi.hoisted(() => ({
  roster: 'Jonathon (human): Busy · idle 0m\nagents: sibling@worker (running, 1m)',
  presence: 'Jonathon (human): Busy · idle 0m',
}));
vi.mock('../../../services/ActiveAgentsRegistry', () => ({
  getActiveAgentsRegistry: () => ({
    buildCompactRoster: async() => f.roster,
    buildHumanPresence: async() => f.presence,
  }),
}));

import { getBuiltinAgentSpecs, renderBuiltinAgent } from '../../../builtinAgents';
import { BaseNode } from '../../../nodes/BaseNode';
import { SystemPromptBuilder, type PromptBuildContext } from '../../../prompts/SystemPromptBuilder';
import { buildTurnContext } from '../../../prompts/turnContext';
import { WorkerPromptBuilder } from '../../../tools/agents/workerMessaging';

class PromptContextNode extends BaseNode {
  async execute(state: any): Promise<any> { return { state, decision: { type: 'end' } } }
  async inject(state: any): Promise<void> {
    await this.injectTurnContext(state);
    this.injectSubconsciousAssistantContext(state);
  }
}

const specs = getBuiltinAgentSpecs();
const worker = specs.find(agent => agent.slug === 'codex-luna-worker')!;
const manager = specs.find(agent => agent.slug === 'coding-manager')!;

function promptContext(spec: typeof worker, aware: boolean): PromptBuildContext {
  const content = renderBuiltinAgent(spec, '/tmp/agent-awareness-test', { name: '', email: '' });
  return {
    mode: 'full', agentId: spec.slug, agentConfig: { name: content.name, prompt: content.prompt_content },
    provider: 'openai', chatMode: 'text', trustLevel: 'trusted', isSubAgent: true, isHeartbeat: false,
    wsChannel: 'sulla-desktop', agentAwareness: aware, templateVars: {}, agentSectionOverrides: new Map(),
    // observational_memory reads Postgres; every other registered section builds for real.
    excludeSections: new Set(['observational_memory']), basePrompt: '',
  };
}

function promptState(agentId: string, aware: boolean): any {
  const identity = new WorkerPromptBuilder().build({
    delegatedJobId: 'job-42', delegatedTaskIndex: 2, managerAgentId: 'coding-manager', managerThreadId: 'manager-thread',
  });
  return {
    messages: [{ role: 'user', content: `${ identity }\n\nTask: implement the assigned change.` }],
    metadata: {
      action: 'direct_answer', threadId: 'job-thread-1', wsChannel: agentId, agentId, agentAwareness: aware,
      subAgentDepth: 1,
      teamDirectoryContext: '<agent_team>\nCalling your team and launching a specialist.\n</agent_team>',
      subagentDirectoryContext: 'child-task-1 running',
    },
  };
}

async function builtPrompt(spec: typeof worker, aware: boolean): Promise<string> {
  const built = await SystemPromptBuilder.build(promptContext(spec, aware));
  const state = promptState(spec.slug, aware);
  await new PromptContextNode(spec.slug, spec.name).inject(state);
  const conversation = state.messages.map((message: any) => typeof message.content === 'string'
    ? message.content
    : message.content.map((part: any) => part.text ?? '').join('\n')).join('\n');
  return `${ built.text }\n${ conversation }`;
}

describe('per-agent prompt awareness', () => {
  it('builds a shorter real codex-luna-worker prompt when disabled, retaining time, presence and task identity', async() => {
    // risk: worker prompts expose other jobs or lose the context needed to do and return their own task.
    const before = await builtPrompt(worker, true);
    const after = await builtPrompt(worker, false);
    console.info(`[AgentAwarenessMeasure] codex-luna-worker before=${ before.length } after=${ after.length }`);
    expect(after.length).toBeLessThan(before.length);
    expect(before).toContain('agents: sibling@worker');
    expect(after).toContain('now="');
    expect(after).toContain('tz=');
    expect(after).toContain('Jonathon (human): Busy');
    expect(after).toContain('Job: job-42 (task 2)');
    expect(after).toContain('Task: implement the assigned change.');
    expect(after).not.toContain('agents: sibling@worker');
    expect(after).not.toContain('<agent_team>');
    expect(after).not.toContain('<subagent_directory>');
    expect(after).not.toContain('Calling your team');
    expect(after).not.toContain('Inter-Agent Communication');
  });

  it('leaves an aware manager prompt, roster and team context available', async() => {
    // risk: managers lose the delegation context needed to own work after the worker-specific opt-out ships.
    const prompt = await builtPrompt(manager, true);
    expect(prompt).toContain('Inter-Agent Communication');
    expect(prompt).toContain('agents: sibling@worker');
    expect(prompt).toContain('<agent_team>');
    expect(prompt).toContain('<subagent_directory>');
  });

  it('keeps presence and time on the generic graph turn-context builder when roster is disabled', async() => {
    // risk: worker context is reduced too far and loses current time or human availability.
    const context = await buildTurnContext({ chatMode: 'text', isHeartbeat: false, agentAwareness: { agent_awareness: false } });
    expect(context).toMatch(/now="[^\"]+" tz=\S+/);
    expect(context).toContain('Jonathon (human): Busy');
    expect(context).not.toContain('agents:');
  });
});
