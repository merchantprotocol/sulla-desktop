/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../database/models/WorkTaskDependencyModel', () => ({
  WorkTaskDependencyModel: {
    create:              jest.fn(),
    remove:              jest.fn(),
    listDependencies:    jest.fn(),
    listDependents:      jest.fn(),
    explainClaimability: jest.fn(),
  },
}));

import { WorkTaskDependencyModel } from '../../../database/models/WorkTaskDependencyModel';
import { CreateTaskDependencyWorker } from '../create_task_dependency';
import { ExplainTaskClaimabilityWorker } from '../explain_task_claimability';
import { ListTaskDependenciesWorker } from '../list_task_dependencies';
import { RemoveTaskDependencyWorker } from '../remove_task_dependency';

const call = (tool: any, input: any) => tool._validatedCall(input);

describe('task dependency tools', () => {
  beforeEach(() => jest.clearAllMocks());

  it('create_task_dependency requires both task ids', async() => {
    const res = await call(new CreateTaskDependencyWorker(), { depends_on_task_id: 'b' });
    expect(res.successBoolean).toBe(false);
    expect(WorkTaskDependencyModel.create).not.toHaveBeenCalled();
  });

  it('create_task_dependency rejects an invalid relation type', async() => {
    const res = await call(new CreateTaskDependencyWorker(), { dependent_task_id: 'a', depends_on_task_id: 'b', relation_type: 'nope' });
    expect(res.successBoolean).toBe(false);
    expect(WorkTaskDependencyModel.create).not.toHaveBeenCalled();
  });

  it('create_task_dependency maps args and reports success', async() => {
    (WorkTaskDependencyModel.create as any).mockResolvedValue({ id: 'dep-1', dependent_task_id: 'a', depends_on_task_id: 'b', relation_type: 'requires' });
    const res = await call(new CreateTaskDependencyWorker(), { dependent_task_id: 'a', depends_on_task_id: 'b' });
    expect(res.successBoolean).toBe(true);
    expect(WorkTaskDependencyModel.create).toHaveBeenCalledWith(expect.objectContaining({ dependentTaskId: 'a', dependsOnTaskId: 'b', relationType: 'requires' }));
  });

  it('create_task_dependency surfaces a cycle error from the model', async() => {
    (WorkTaskDependencyModel.create as any).mockRejectedValue(new Error('would create a cycle'));
    const res = await call(new CreateTaskDependencyWorker(), { dependent_task_id: 'a', depends_on_task_id: 'b' });
    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toMatch(/cycle/i);
  });

  it('remove_task_dependency requires id or both task ids', async() => {
    expect((await call(new RemoveTaskDependencyWorker(), {})).successBoolean).toBe(false);
    (WorkTaskDependencyModel.remove as any).mockResolvedValue(true);
    const res = await call(new RemoveTaskDependencyWorker(), { id: 'dep-1' });
    expect(res.successBoolean).toBe(true);
    expect(WorkTaskDependencyModel.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'dep-1' }));
  });

  it('list_task_dependencies requires task_id and returns both directions', async() => {
    expect((await call(new ListTaskDependenciesWorker(), {})).successBoolean).toBe(false);
    (WorkTaskDependencyModel.listDependencies as any).mockResolvedValue([{ id: 'd1' }]);
    (WorkTaskDependencyModel.listDependents as any).mockResolvedValue([]);
    const res = await call(new ListTaskDependenciesWorker(), { task_id: 't1' });
    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('dependencies');
  });

  it('explain_task_claimability returns the explanation payload', async() => {
    (WorkTaskDependencyModel.explainClaimability as any).mockResolvedValue({ taskId: 't1', claimable: false, reason: 'x', unresolved: [], chain: [] });
    const res = await call(new ExplainTaskClaimabilityWorker(), { task_id: 't1' });
    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('claimable');
  });
});
