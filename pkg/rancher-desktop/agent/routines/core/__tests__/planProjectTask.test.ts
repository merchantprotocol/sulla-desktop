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

  it('has the required independent fan-out, wait-all synthesis, persistence, and response graph', () => {
    expect(PLAN_PROJECT_TASK_ID).toBe('core-routine-plan-project-task');
    const nodes = new Map(definition.nodes.map(node => [node.id, node]));
    const planners = ['node-plan-a', 'node-plan-b', 'node-plan-c'];

    expect(nodes.get('node-plan-trigger')?.data.subtype).toBe('manual');
    expect(nodes.get('node-plan-fanout')?.data.subtype).toBe('parallel');
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

  it('spawns exactly three planners together and gives every result to a separate synthesizer', () => {
    let playbook = createPlaybookState(definition, JSON.stringify({ task: { id: 'task-1' } }));

    const fanout = processNextStep(playbook);
    expect(fanout.action).toBe('node_completed');
    playbook = fanout.updatedPlaybook;

    const batch = processNextStep(playbook);
    expect(batch.action).toBe('spawn_parallel_agents');
    if (batch.action !== 'spawn_parallel_agents') throw new Error('expected parallel planner batch');
    expect(batch.nodes.map(node => node.nodeId).sort()).toEqual([
      'node-plan-a',
      'node-plan-b',
      'node-plan-c',
    ]);
    expect(batch.nodes.every(node => node.prompt.includes('"id":"task-1"'))).toBe(true);

    playbook = completeSubAgent(playbook, 'node-plan-a', 'plan A').updatedPlaybook;
    playbook = completeSubAgent(playbook, 'node-plan-b', 'plan B').updatedPlaybook;
    playbook = completeSubAgent(playbook, 'node-plan-c', 'plan C').updatedPlaybook;

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
    expect(synthesis.prompt).toContain('DISPOSITION: TODO');

    playbook = completeSubAgent(playbook, 'node-plan-synthesis', 'DISPOSITION: TODO\n1. Implement safely.').updatedPlaybook;
    const persistence = processNextStep(playbook);
    expect(persistence.action).toBe('spawn_sub_agent');
    if (persistence.action !== 'spawn_sub_agent') throw new Error('expected persistence agent');
    expect(persistence.nodeId).toBe('node-plan-persist');
    expect(persistence.prompt).toContain('DISPOSITION: TODO');
    expect(persistence.prompt).toContain('sulla project/add_task_comment');

    playbook = completeSubAgent(playbook, 'node-plan-persist', 'Persisted plan; task is todo/dispatcher.').updatedPlaybook;
    const response = processNextStep(playbook);
    expect(response.action).toBe('prompt_agent');
  });

  it('pins safety and Projects persistence requirements in the recordkeeper', () => {
    const persist = definition.nodes.find(node => node.id === 'node-plan-persist');
    const prompt = String(persist?.data.config.orchestratorInstructions);

    expect(prompt).toContain('sulla project/add_task_comment');
    expect(prompt).toContain('sulla project/update_task');
    expect(prompt).toContain('transition_task_to_execution');
    expect(prompt).toContain('never infer the target from relative ordering');
    expect(prompt).toContain('transition_task_stage');
    expect(prompt).toContain('exception stage key `blocked`');
    expect(prompt).toContain('Never merge or deploy');
  });
});
