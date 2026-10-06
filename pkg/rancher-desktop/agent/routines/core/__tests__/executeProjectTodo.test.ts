import { describe, expect, it } from '@jest/globals';

import { validateWorkflowDefinition } from '../../../tools/workflow/validate_sulla_workflow';
import { EXECUTE_PROJECT_TODO_DEFINITION, EXECUTE_PROJECT_TODO_ID } from '../executeProjectTodo';
import { CORE_ROUTINES } from '../index';

describe('Projects execution-entry core routine', () => {
  it('ships enabled and delegates to exactly one mechanical owner', () => {
    expect(EXECUTE_PROJECT_TODO_DEFINITION.id).toBe(EXECUTE_PROJECT_TODO_ID);
    expect(EXECUTE_PROJECT_TODO_DEFINITION.enabled).toBe(true);
    expect(CORE_ROUTINES).toContain(EXECUTE_PROJECT_TODO_DEFINITION);
    expect(EXECUTE_PROJECT_TODO_DEFINITION.laneContract.owner).toBe('task-dispatcher');
    const agents = EXECUTE_PROJECT_TODO_DEFINITION.nodes.filter((node: any) => node.data.subtype === 'agent');
    expect(agents).toHaveLength(0);
    expect(EXECUTE_PROJECT_TODO_DEFINITION.nodes.map((node: any) => node.data.category)).toEqual(['trigger', 'io']);
    expect(JSON.stringify(EXECUTE_PROJECT_TODO_DEFINITION)).not.toContain('orchestratorInstructions');
    expect(JSON.stringify(EXECUTE_PROJECT_TODO_DEFINITION)).toContain('sole execution owner');
  });

  it('passes the shipped workflow validator', () => {
    const issues = validateWorkflowDefinition(EXECUTE_PROJECT_TODO_DEFINITION);
    expect(issues.filter(issue => issue.severity === 'error')).toEqual([]);
  });
});
