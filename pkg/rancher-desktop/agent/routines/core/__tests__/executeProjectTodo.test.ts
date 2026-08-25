import { describe, expect, it } from '@jest/globals';

import { createPlaybookState } from '../../../workflow/WorkflowPlaybook';
import { DEFAULT_CORE_ROUTINE_AGENT_ID } from '../defaultCoreAgent';
import { EXECUTE_PROJECT_TODO_DEFINITION, EXECUTE_PROJECT_TODO_ID } from '../executeProjectTodo';
import { CORE_ROUTINES } from '../index';

describe('Execute Projects Todo core routine', () => {
  it('is a connected locked-core-compatible graph with the complete custody lifecycle', () => {
    const ids = EXECUTE_PROJECT_TODO_DEFINITION.nodes.map((node: any) => node.id);
    const labels = EXECUTE_PROJECT_TODO_DEFINITION.nodes.map((node: any) => node.data.label);
    const incoming = new Set(EXECUTE_PROJECT_TODO_DEFINITION.edges.map((edge: any) => edge.target));

    expect(EXECUTE_PROJECT_TODO_DEFINITION.id).toBe(EXECUTE_PROJECT_TODO_ID);
    expect(EXECUTE_PROJECT_TODO_DEFINITION.enabled).toBe(false);
    expect(labels).toEqual(expect.arrayContaining([
      'Claimed Todo',
      'Classify Work',
      'Dynamic Worker Fan-out',
      'Independent Acceptance Review',
      'Repair or Replan',
      'Artifact Custody',
      'Record Projects Handoff',
    ]));
    expect(ids.filter((id: string) => id !== 'node-todo-trigger').every((id: string) => incoming.has(id))).toBe(true);
    expect(() => createPlaybookState(EXECUTE_PROJECT_TODO_DEFINITION as any, '{"taskId":"task-1"}')).not.toThrow();
  });

  it('requires capability selection, independent inspection, configurable disposition, and durable remote evidence', () => {
    const text = JSON.stringify(EXECUTE_PROJECT_TODO_DEFINITION);

    expect(text).toContain(`every assignment must use agentId ${ DEFAULT_CORE_ROUTINE_AGENT_ID }`);
    expect(text).toContain('Never select or name a custom agent profile');
    expect(text).toContain('You did not execute the work');
    expect(text).toContain('configured planning stage');
    expect(text).toContain('transition_task_relative');
    expect(text).toContain('transition_task_stage');
    expect(text).toContain('remote draft PR');
    expect(text).toContain('authoritative tracker');
    expect(text).toContain('Never merge or deploy');
    expect(text).toContain('Graph nodes are proposal-only');
    expect(text).toContain('Do not call any project write tool');
    expect(text).toContain('pipeline runner will validate the originating task and live canonical artifact');
    expect(text).not.toContain('recorded=true');
  });

  it('pins every baked-in core routine agent node to the default Sulla Desktop profile', () => {
    for (const routine of CORE_ROUTINES) {
      const agentNodes = routine.nodes.filter((node: any) => node.data?.subtype === 'agent');
      expect(agentNodes.length).toBeGreaterThan(0);
      expect(agentNodes.every((node: any) =>
        node.data.config.agentId === DEFAULT_CORE_ROUTINE_AGENT_ID,
      )).toBe(true);
    }
  });
});
