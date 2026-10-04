import { describe, expect, it } from '@jest/globals';

import { validateWorkflowDefinition } from '../../../tools/workflow/validate_sulla_workflow';
import {
  completeSubAgent,
  createPlaybookState,
  processNextStep,
} from '../../../workflow/WorkflowPlaybook';
import { DEFAULT_CORE_ROUTINE_AGENT_ID } from '../defaultCoreAgent';
import { PLAN_PROJECT_TASK_DEFINITION, PLAN_PROJECT_TASK_ID } from '../planProjectTask';

import type { WorkflowDefinition } from '@pkg/pages/editor/workflow/types';

const definition = PLAN_PROJECT_TASK_DEFINITION as WorkflowDefinition;

describe('locked Projects planning routine', () => {
  it('passes the shipped workflow graph validator', () => {
    const issues = validateWorkflowDefinition(PLAN_PROJECT_TASK_DEFINITION);
    expect(issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('has the required serial planners, wait-all synthesis, persistence, and response graph', () => {
    expect(PLAN_PROJECT_TASK_ID).toBe('core-routine-plan-project-task');
    const nodes = new Map(definition.nodes.map(node => [node.id, node]));
    const planners = ['node-plan-a', 'node-plan-b', 'node-plan-c'];

    expect(nodes.get('node-plan-trigger')?.data.subtype).toBe('manual');
    expect(nodes.get('node-plan-fanout')?.data.subtype).toBe('merge');
    expect(nodes.get('node-plan-merge')?.data.config).toMatchObject({ strategy: 'wait-all' });
    expect(nodes.get('node-plan-synthesis')?.data.subtype).toBe('agent');
    expect(nodes.get('node-plan-persist')?.data.subtype).toBe('agent');
    expect(nodes.get('node-plan-done')?.data.subtype).toBe('response');
    expect(planners.every(id => nodes.get(id)?.data.config.agentId === DEFAULT_CORE_ROUTINE_AGENT_ID)).toBe(true);
    expect(nodes.get('node-plan-synthesis')?.data.config.agentId).toBe(DEFAULT_CORE_ROUTINE_AGENT_ID);
    expect(nodes.get('node-plan-persist')?.data.config.agentId).toBe(DEFAULT_CORE_ROUTINE_AGENT_ID);

    for (const plannerId of planners) {
      const prompt = String(nodes.get(plannerId)?.data.config.orchestratorInstructions);
      expect(prompt).toContain('{{trigger}}');
      expect(prompt).not.toContain('Planner A]:');
      expect(prompt).not.toContain('Planner B]:');
      expect(prompt).not.toContain('Planner C]:');
    }
  });

  it('runs three planners serially and gives every result to a separate synthesizer', () => {
    let playbook = createPlaybookState(definition, JSON.stringify({ task: { id: 'task-1' } }));

    const fanout = processNextStep(playbook);
    expect(fanout.action).toBe('node_completed');
    playbook = fanout.updatedPlaybook;

    for (const [id, result] of [['node-plan-a', 'plan A'], ['node-plan-b', 'plan B'], ['node-plan-c', 'plan C']]) {
      const step = processNextStep(playbook);
      expect(step.action).toBe('spawn_sub_agent');
      if (step.action !== 'spawn_sub_agent') throw new Error('expected exclusive planner');
      expect(step.nodeId).toBe(id);
      expect(step.prompt).toContain('"id":"task-1"');
      playbook = completeSubAgent(step.updatedPlaybook, id, result).updatedPlaybook;
    }

    const merge = processNextStep(playbook);
    expect(merge.action).toBe('node_completed');
    playbook = merge.updatedPlaybook;

    const synthesis = processNextStep(playbook);
    expect(synthesis.action).toBe('spawn_sub_agent');
    if (synthesis.action !== 'spawn_sub_agent') throw new Error('expected synthesis agent');
    expect(synthesis.nodeId).toBe('node-plan-synthesis');
    expect(synthesis.prompt).toContain('plan A');
    expect(synthesis.prompt).toContain('plan B');
    expect(synthesis.prompt).toContain('plan C');
    expect(synthesis.prompt).not.toMatch(/\{\{[^}]+\}\}/);
    expect(synthesis.prompt).toContain('DISPOSITION: REVIEW');

    playbook = completeSubAgent(synthesis.updatedPlaybook, 'node-plan-synthesis', 'DISPOSITION: REVIEW\n1. Implement safely.').updatedPlaybook;
    const persistence = processNextStep(playbook);
    expect(persistence.action).toBe('spawn_sub_agent');
    if (persistence.action !== 'spawn_sub_agent') throw new Error('expected persistence agent');
    expect(persistence.nodeId).toBe('node-plan-persist');
    expect(persistence.prompt).toContain('DISPOSITION: REVIEW\n1. Implement safely.');
    expect(persistence.prompt).not.toMatch(/\{\{[^}]+\}\}/);
    expect(persistence.prompt).toContain('sulla project/add_task_comment');

    playbook = completeSubAgent(persistence.updatedPlaybook, 'node-plan-persist', 'Persisted receipt; task advanced to verification.').updatedPlaybook;
    const response = processNextStep(playbook);
    expect(response.action).toBe('prompt_agent');
  });

  it('pins safety and Projects persistence requirements in the recordkeeper', () => {
    const persist = definition.nodes.find(node => node.id === 'node-plan-persist');
    const prompt = String(persist?.data.config.orchestratorInstructions);

    expect(prompt).toContain('sulla project/add_task_comment');
    expect(prompt).toContain('sulla project/transition_task_stage');
    expect(prompt).toContain('configured verification lane');
    expect(prompt).toContain('Never move unfinished work to todo or planning');
    expect(prompt).toContain('transition_task_stage');
    expect(prompt).toContain('exception stage key `blocked`');
    expect(prompt).toContain('Never merge or deploy');
  });
});
