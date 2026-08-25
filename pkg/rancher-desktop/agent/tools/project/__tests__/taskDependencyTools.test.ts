/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { getProjectsApplicationService } from '../../../projects/application/ProjectsApplicationService';
import { CreateTaskDependencyWorker } from '../create_task_dependency';
import { ExplainTaskClaimabilityWorker } from '../explain_task_claimability';
import { ListTaskDependenciesWorker } from '../list_task_dependencies';
import { RemoveTaskDependencyWorker } from '../remove_task_dependency';

const projects = getProjectsApplicationService() as any;
const createDependency = jest.spyOn(projects, 'createDependency');
const removeDependency = jest.spyOn(projects, 'removeDependency');
const listDependencies = jest.spyOn(projects, 'listDependencies');
const listDependents = jest.spyOn(projects, 'listDependents');
const explainTaskClaimability = jest.spyOn(projects, 'explainTaskClaimability');

const call = (tool: any, input: any) => tool._validatedCall(input);

describe('task dependency tools', () => {
  beforeEach(() => { jest.clearAllMocks() });

  it('create_task_dependency requires both task ids', async() => {
    const res = await call(new CreateTaskDependencyWorker(), { depends_on_task_id: 'b' });
    expect(res.successBoolean).toBe(false);
    expect(createDependency).not.toHaveBeenCalled();
  });

  it('create_task_dependency rejects an invalid relation type', async() => {
    const res = await call(new CreateTaskDependencyWorker(), { dependent_task_id: 'a', depends_on_task_id: 'b', relation_type: 'nope' });
    expect(res.successBoolean).toBe(false);
    expect(createDependency).not.toHaveBeenCalled();
  });

  it('create_task_dependency maps args and reports success', async() => {
    createDependency.mockResolvedValue({ id: 'dep-1', dependent_task_id: 'a', depends_on_task_id: 'b', relation_type: 'requires' });
    const res = await call(new CreateTaskDependencyWorker(), { dependent_task_id: 'a', depends_on_task_id: 'b' });
    expect(res.successBoolean).toBe(true);
    expect(createDependency).toHaveBeenCalledWith(expect.objectContaining({ dependentTaskId: 'a', dependsOnTaskId: 'b', relationType: 'requires' }), expect.any(Object));
  });

  it('create_task_dependency surfaces a cycle error from the model', async() => {
    createDependency.mockRejectedValue(new Error('would create a cycle'));
    const res = await call(new CreateTaskDependencyWorker(), { dependent_task_id: 'a', depends_on_task_id: 'b' });
    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toMatch(/cycle/i);
  });

  it('remove_task_dependency requires id or both task ids', async() => {
    expect((await call(new RemoveTaskDependencyWorker(), {})).successBoolean).toBe(false);
    removeDependency.mockResolvedValue(true);
    const res = await call(new RemoveTaskDependencyWorker(), { id: 'dep-1' });
    expect(res.successBoolean).toBe(true);
    expect(removeDependency).toHaveBeenCalledWith(expect.objectContaining({ id: 'dep-1' }), expect.any(Object));
  });

  it('list_task_dependencies requires task_id and returns both directions', async() => {
    expect((await call(new ListTaskDependenciesWorker(), {})).successBoolean).toBe(false);
    listDependencies.mockResolvedValue([{ id: 'd1' }]);
    listDependents.mockResolvedValue([]);
    const res = await call(new ListTaskDependenciesWorker(), { task_id: 't1' });
    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('dependencies');
  });

  it('explain_task_claimability returns the explanation payload', async() => {
    explainTaskClaimability.mockResolvedValue({ taskId: 't1', claimable: false, reason: 'x', unresolved: [], chain: [] });
    const res = await call(new ExplainTaskClaimabilityWorker(), { task_id: 't1' });
    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('claimable');
  });
});
