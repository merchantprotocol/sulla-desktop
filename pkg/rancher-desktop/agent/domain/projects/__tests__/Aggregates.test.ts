import { Board, Epic, Project, Task } from '../entities';
import { DomainError } from '../errors';
import { EpicId, LaneKey, ProjectId, SemanticRole, TaskId } from '../values';

describe('Projects aggregates', () => {
  const projectId = ProjectId.of('project-1');
  const epicId = EpicId.of('epic-1');

  it('constructs immutable project, epic, and task aggregates', () => {
    const project = new Project({ id: projectId, title: ' Project ' });
    const epic = new Epic({ id: epicId, projectId, title: ' Epic ' });
    const task = new Task({
      id: TaskId.of('task-1'), projectId, epicId, title: ' Task ',
      lane: LaneKey.of('todo'), semanticRole: SemanticRole.EXECUTION, labels: ['p0'],
    });
    expect(project.title).toBe('Project');
    expect(epic.title).toBe('Epic');
    expect(task.title).toBe('Task');
    expect(task.labels).toEqual(['p0']);
    expect(Object.isFrozen(task)).toBe(true);
  });

  it('moves active tasks without mutating the source aggregate', () => {
    const task = new Task({
      id: TaskId.of('task-1'), projectId, epicId: null, title: 'Task',
      lane: LaneKey.of('blocked'), semanticRole: SemanticRole.BLOCKED,
    });
    const moved = task.moveTo(LaneKey.of('planning'), SemanticRole.PLANNING);
    expect(task.lane.value).toBe('blocked');
    expect(moved.lane.value).toBe('planning');
    expect(moved.id).toBe(task.id);
  });

  it('rejects empty titles and archived-task transitions', () => {
    expect(() => new Project({ id: projectId, title: ' ' })).toThrow(DomainError);
    const task = new Task({
      id: TaskId.of('task-1'), projectId, epicId, title: 'Task', archived: true,
      lane: LaneKey.of('todo'), semanticRole: SemanticRole.EXECUTION,
    });
    expect(() => task.moveTo(LaneKey.of('in_progress'), SemanticRole.EXECUTION)).toThrow(DomainError);
  });

  it('orders configured lanes and advances through custom keys, not literal statuses', () => {
    const board = new Board(projectId, [
      { key: LaneKey.of('verify'), semanticRole: SemanticRole.REVIEW, position: 20, enabled: true },
      { key: LaneKey.of('build'), semanticRole: SemanticRole.EXECUTION, position: 10, enabled: true },
      { key: LaneKey.of('paused'), semanticRole: SemanticRole.MANUAL, position: 15, enabled: false },
    ]);
    expect(board.lanes.map(lane => lane.key.value)).toEqual(['build', 'paused', 'verify']);
    expect(board.nextLane(LaneKey.of('build'))?.key.value).toBe('verify');
    expect(board.nextLane(LaneKey.of('verify'))).toBeNull();
    expect(() => board.lane(LaneKey.of('paused'))).toThrow(DomainError);
  });

  it('rejects duplicate lane keys and invalid positions', () => {
    const lane = { key: LaneKey.of('todo'), semanticRole: SemanticRole.EXECUTION, position: 0, enabled: true };
    expect(() => new Board(projectId, [lane, { ...lane, position: 1 }])).toThrow('unique');
    expect(() => new Board(projectId, [{ ...lane, position: -1 }])).toThrow('non-negative');
  });

  it('can validate whether a resolved board contains every required semantic role', () => {
    const lanes = SemanticRole.REQUIRED.map((role, position) => ({
      key: LaneKey.of(`lane_${ role }`), semanticRole: SemanticRole.of(role), position, enabled: true,
    }));
    expect(() => new Board(projectId, lanes).assertOperational()).not.toThrow();
    expect(() => new Board(projectId, lanes.slice(1)).assertOperational()).toThrow('backlog');
  });
});
