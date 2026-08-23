import { describe, expect, it } from '@jest/globals';

import { createPlaybookState } from '../../../workflow/WorkflowPlaybook';
import { EXECUTE_PROJECT_TODO_DEFINITION, EXECUTE_PROJECT_TODO_ID } from '../executeProjectTodo';

describe('Execute Projects Todo core routine', () => {
  it('is a connected locked-core-compatible graph with the complete custody lifecycle', () => {
    const ids = EXECUTE_PROJECT_TODO_DEFINITION.nodes.map((node: any) => node.id);
    const labels = EXECUTE_PROJECT_TODO_DEFINITION.nodes.map((node: any) => node.data.label);
    const incoming = new Set(EXECUTE_PROJECT_TODO_DEFINITION.edges.map((edge: any) => edge.target));

    expect(EXECUTE_PROJECT_TODO_DEFINITION.id).toBe(EXECUTE_PROJECT_TODO_ID);
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

  it('requires capability selection, independent inspection, #667 replan, and durable remote evidence', () => {
    const text = JSON.stringify(EXECUTE_PROJECT_TODO_DEFINITION);

    expect(text).toContain('Choose 1-10 existing agent IDs based on their real capabilities');
    expect(text).toContain('You did not execute the work');
    expect(text).toContain('core-routine-plan-project-task');
    expect(text).toContain('remote draft PR');
    expect(text).toContain('authoritative tracker');
    expect(text).toContain('Never merge or deploy');
  });
});
