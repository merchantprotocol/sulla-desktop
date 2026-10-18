import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authenticateProjectsRequest } from '../dist/auth.js';

import { ProjectsApplicationService } from '../dist/domain/ProjectsApplicationService.js';
import { WorkTaskDependencyModel } from '../dist/domain/models/WorkTaskDependencyModel.js';

test('domain rejects forged human authority before persisting a task change', async () => {
  let writes = 0;
  const service = new ProjectsApplicationService({
    getTask: async () => ({ id: 'task', status: 'todo' }),
    updateTask: async () => { writes++; },
  });
  for (const source of ['tool', 'routine', 'heartbeat']) {
    await assert.rejects(service.updateTask('task', { actor: 'human' }, { actor: 'human', source }), /cannot act as the human/);
  }
  assert.equal(writes, 0);
});

test('readiness follows dependencies outside the initial page and excludes closed prerequisites', async (t) => {
  const tasks = {
    middle: { id: 'middle', status: 'todo' },
    leaf: { id: 'leaf', status: 'todo' },
    closed: { id: 'closed', status: 'cancelled' },
  };
  const hold = (taskId, dependsOnTaskId) => ({ taskId, dependsOnTaskId, policy: 'pending' });
  t.mock.method(WorkTaskDependencyModel, 'listUnresolvedForTasks', async (ids) =>
    ids.includes('root') ? [hold('root', 'middle')] : ids.includes('middle')
      ? [hold('middle', 'leaf'), hold('middle', 'closed')] : []);
  const service = new ProjectsApplicationService({
    listTasks: async () => [{ id: 'root' }],
    getTask: async (id) => tasks[id] ?? null,
  });
  const result = await service.readyTasks({ projectId: 'project', limit: 1 });
  assert.deepEqual(result.ready, []);
  assert.deepEqual(result.runnablePrerequisites, [tasks.leaf]);
  assert.equal(result.blocked[0].task.id, 'root');
});


test('task creation attributes writes to authenticated context', async () => {
  let stored;
  const service = new ProjectsApplicationService({
    createTask: async (input) => { stored = input; return input; },
  });
  await service.createTask({ id: 'task', project_id: 'project', title: 'Task', actor: 'forged-agent' },
    { actor: 'authenticated-agent', source: 'tool' });
  assert.equal(stored.actor, 'authenticated-agent');
});


test('local service capabilities cannot impersonate human aliases', () => {
  for (const actor of ['human', 'Human', ' USER ', 'owner', 'me', 'Jonathon']) {
    const identity = authenticateProjectsRequest({ authorization: 'Bearer synthetic-service',
      localToken: 'synthetic-service', mode: 'desktop', localSubject: 'desktop',
      localTenant: 'desktop', jwtAudience: 'sulla-projects', localActor: actor, localSource: 'tool' });
    assert.equal(identity.actor, 'sulla');
  }
});
