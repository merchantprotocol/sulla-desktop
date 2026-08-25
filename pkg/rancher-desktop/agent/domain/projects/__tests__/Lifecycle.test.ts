import { Task } from '../entities';
import { DomainError } from '../errors';
import {
  CustodyReceipt, Dependency, DispatchLease, DurableWait, LifecyclePolicy, LifecycleTransition,
} from '../lifecycle';
import { ArtifactGeneration, LaneKey, ProjectId, SemanticRole, TaskId } from '../values';

const taskId = TaskId.of('task-1');
const projectId = ProjectId.of('project-1');
const generation = ArtifactGeneration.of(3, 'sha-3');

function task(lane: string, role: SemanticRole): Task {
  return new Task({
    id: taskId, projectId, epicId: null, title: 'Task', lane: LaneKey.of(lane),
    semanticRole: role, artifactGeneration: generation, assignee: 'worker',
  });
}

describe('Projects lifecycle', () => {
  const now = new Date('2026-08-24T23:00:00.000Z');

  it('creates an immutable generation-scoped domain event', () => {
    const transition = new LifecycleTransition(
      task('todo', SemanticRole.EXECUTION), task('in_progress', SemanticRole.EXECUTION),
      'worker', 'dispatcher',
    );
    const event = transition.toEvent('event-1', now);
    expect(event.payload).toMatchObject({ fromLane: 'todo', toLane: 'in_progress', actor: 'worker' });
    expect(event.generation.equals(generation)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('rejects identity, aggregate, actor, and no-op transition violations', () => {
    const from = task('todo', SemanticRole.EXECUTION);
    expect(() => new LifecycleTransition(from, task('todo', SemanticRole.EXECUTION), 'worker', 'tool'))
      .toThrow('change lanes');
    expect(() => new LifecycleTransition(from, task('in_progress', SemanticRole.EXECUTION), ' ', 'tool'))
      .toThrow('actor');
    const other = new Task({ ...from, id: TaskId.of('other'), lane: LaneKey.of('in_progress') });
    expect(() => new LifecycleTransition(from, other, 'worker', 'tool')).toThrow('identity');
  });

  it('blocks execution while dependencies, WIP, or current-generation waits are unresolved', () => {
    const transition = new LifecycleTransition(
      task('backlog', SemanticRole.BACKLOG), task('todo', SemanticRole.EXECUTION), 'worker', 'tool',
    );
    expect(() => LifecyclePolicy.authorize(transition, {
      now, dependencies: [new Dependency(taskId, TaskId.of('dep'), false)],
    })).toThrow('dependencies');
    expect(() => LifecyclePolicy.authorize(transition, { now, wipAvailable: false })).toThrow('WIP');
    expect(() => LifecyclePolicy.authorize(transition, {
      now, waits: [new DurableWait(taskId, 'human_gate', 'approval', generation, true)],
    })).toThrow('durable wait');
  });

  it('enforces active lease ownership and exact artifact custody', () => {
    const transition = new LifecycleTransition(
      task('in_progress', SemanticRole.EXECUTION), task('in_review', SemanticRole.REVIEW),
      'worker', 'dispatcher',
    );
    const lease = new DispatchLease(taskId, 'other', generation, new Date(now.getTime() + 60_000));
    expect(() => LifecyclePolicy.authorize(transition, { now, lease, custody: [] })).toThrow('lease');
    const ownedLease = new DispatchLease(taskId, 'worker', generation, new Date(now.getTime() + 60_000));
    expect(() => LifecyclePolicy.authorize(transition, { now, lease: ownedLease, custody: [] })).toThrow('custody');
    const wrongGeneration = new CustodyReceipt(taskId, ArtifactGeneration.of(2), 'code', 'pr:1', 'sha-2');
    expect(() => LifecyclePolicy.authorize(transition, {
      now, lease: ownedLease, custody: [wrongGeneration],
    })).toThrow('custody');
    const receipt = new CustodyReceipt(taskId, generation, 'code', 'pr:1', 'sha-3');
    expect(() => LifecyclePolicy.authorize(transition, { now, lease: ownedLease, custody: [receipt] }))
      .not.toThrow();
  });

  it('fails closed when repositories supply facts for another task', () => {
    const transition = new LifecycleTransition(
      task('backlog', SemanticRole.BACKLOG), task('todo', SemanticRole.EXECUTION), 'worker', 'tool',
    );
    const otherTask = TaskId.of('other');
    expect(() => LifecyclePolicy.authorize(transition, {
      now, dependencies: [new Dependency(otherTask, TaskId.of('dep'), true)],
    })).toThrow('another task');
    expect(() => LifecyclePolicy.authorize(transition, {
      now, waits: [new DurableWait(otherTask, 'human_gate', 'approval', generation, false)],
    })).toThrow('another task');
    expect(() => LifecyclePolicy.authorize(transition, {
      now, lease: new DispatchLease(otherTask, 'worker', generation, new Date(now.getTime() + 60_000)),
    })).toThrow('another task');
  });

  it('does not let callers mutate a dispatch lease expiry after construction', () => {
    const mutableExpiry = new Date(now.getTime() + 60_000);
    const lease = new DispatchLease(taskId, 'worker', generation, mutableExpiry);
    mutableExpiry.setTime(now.getTime() - 1);
    expect(lease.isActive(now)).toBe(true);
    const exposed = lease.expiresAt;
    exposed.setTime(now.getTime() - 1);
    expect(lease.isActive(now)).toBe(true);
  });

  it('rejects self-dependencies and malformed domain objects', () => {
    expect(() => new Dependency(taskId, taskId, false)).toThrow(DomainError);
    expect(() => new DurableWait(taskId, 'human_gate', ' ', generation, true)).toThrow(DomainError);
    expect(() => new CustodyReceipt(taskId, generation, 'code', '', 'sha')).toThrow(DomainError);
  });
});
