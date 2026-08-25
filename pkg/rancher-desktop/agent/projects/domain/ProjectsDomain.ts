import type { WorkLaneSemanticRole } from '../../database/models/WorkLaneDefinitionModel';

/** Stable identifiers used by the Projects domain. */
export class ProjectItemId {
  private constructor(readonly value: string) {}

  static from(value: unknown, field = 'id'): ProjectItemId {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) throw new Error(`${ field } is required.`);
    return new ProjectItemId(normalized);
  }
}

/** A configured lane key. Keys are stable; display names remain presentation data. */
export class LaneKey {
  private constructor(readonly value: string) {}

  static from(value: unknown): LaneKey {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) throw new Error('lane key is required.');
    return new LaneKey(normalized);
  }
}

function requiredText(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${ field } is required.`);
  return normalized;
}

export class Lane {
  private constructor(
    readonly key: LaneKey,
    readonly displayName: string,
    readonly semanticRole: WorkLaneSemanticRole,
  ) {}
  static create(input: { key: string; displayName: string; semanticRole: WorkLaneSemanticRole }): Lane {
    return new Lane(LaneKey.from(input.key), requiredText(input.displayName, 'lane display name'), input.semanticRole);
  }
}

/** Domain aggregates are intentionally persistence-free and immutable. */
export class Project {
  private constructor(readonly id: ProjectItemId, readonly title: string) {}
  static create(input: { id: string; title: string }): Project {
    return new Project(ProjectItemId.from(input.id, 'project_id'), requiredText(input.title, 'project title'));
  }
}

export class Epic {
  private constructor(readonly id: ProjectItemId, readonly projectId: ProjectItemId, readonly title: string) {}
  static create(input: { id: string; projectId: string; title: string }): Epic {
    return new Epic(
      ProjectItemId.from(input.id, 'epic_id'),
      ProjectItemId.from(input.projectId, 'project_id'),
      requiredText(input.title, 'epic title'),
    );
  }
}

export class Task {
  private constructor(
    readonly id: ProjectItemId,
    readonly epicId: ProjectItemId,
    readonly projectId: ProjectItemId,
    readonly title: string,
    readonly lane: LaneKey,
  ) {}
  static create(input: { id: string; epicId: string; projectId: string; title: string; lane: string }): Task {
    return new Task(
      ProjectItemId.from(input.id, 'task_id'),
      ProjectItemId.from(input.epicId, 'epic_id'),
      ProjectItemId.from(input.projectId, 'project_id'),
      requiredText(input.title, 'task title'),
      LaneKey.from(input.lane),
    );
  }
}

export class Dependency {
  private constructor(readonly taskId: ProjectItemId, readonly dependsOnTaskId: ProjectItemId) {}
  static create(taskId: string, dependsOnTaskId: string): Dependency {
    const dependent = ProjectItemId.from(taskId, 'task_id');
    const prerequisite = ProjectItemId.from(dependsOnTaskId, 'depends_on_task_id');
    if (dependent.value === prerequisite.value) throw new Error('A task cannot depend on itself.');
    return new Dependency(dependent, prerequisite);
  }
}

export class WaitTarget {
  private constructor(readonly kind: string, readonly key: string) {}
  static create(kind: string, key: string): WaitTarget {
    return new WaitTarget(requiredText(kind, 'wait kind'), requiredText(key, 'wait target key'));
  }
}

export class ProjectView {
  private constructor(readonly id: ProjectItemId, readonly name: string, readonly projectId: ProjectItemId | null) {}
  static create(input: { id: string; name: string; projectId?: string | null }): ProjectView {
    return new ProjectView(
      ProjectItemId.from(input.id, 'view_id'),
      requiredText(input.name, 'view name'),
      input.projectId ? ProjectItemId.from(input.projectId, 'project_id') : null,
    );
  }
}

export class KnowledgeAssociation {
  private constructor(
    readonly itemKind: 'project' | 'epic' | 'task',
    readonly itemId: ProjectItemId,
    readonly nodeId: ProjectItemId,
  ) {}
  static create(input: { itemKind: 'project' | 'epic' | 'task'; itemId: string; nodeId: string }): KnowledgeAssociation {
    return new KnowledgeAssociation(
      input.itemKind,
      ProjectItemId.from(input.itemId, `${ input.itemKind }_id`),
      ProjectItemId.from(input.nodeId, 'knowledge_node_id'),
    );
  }
}

export interface TaskLifecycleState {
  taskId:       ProjectItemId;
  projectId:    ProjectItemId;
  lane:         LaneKey;
  semanticRole: WorkLaneSemanticRole;
  assignee:     string | null;
  labels:       string[];
}

export interface TaskTransition {
  from:                  TaskLifecycleState;
  to:                    TaskLifecycleState;
  actor:                 string;
  destinationEpicProven: boolean;
}

/**
 * Pure lifecycle rules. Persistence, IPC and tools are deliberately absent.
 * Infrastructure policies (custody, dependencies, leases and WIP) are composed
 * by the application service before a transition is committed.
 */
export class TaskLifecyclePolicy {
  static assertTransition(transition: TaskTransition): void {
    if (!transition.actor.trim()) throw new Error('actor is required for a task transition.');
    if (transition.from.projectId.value !== transition.to.projectId.value && !transition.destinationEpicProven) {
      throw new Error('A task cannot change projects without moving through an epic in the destination project.');
    }
    if (transition.to.semanticRole === 'terminal' && transition.to.assignee === 'dispatcher') {
      throw new Error('Terminal tasks cannot remain assigned to dispatcher.');
    }
  }
}

export type ProjectsCommand =
  | 'createProject' | 'updateProject' | 'archiveProject'
  | 'createEpic' | 'updateEpic' | 'archiveEpic'
  | 'createTask' | 'updateTask' | 'archiveTask' | 'reorder'
  | 'addComment' | 'setDependency' | 'removeDependency';

export interface ProjectsCommandContext {
  actor:  string;
  source: 'tool' | 'ipc' | 'heartbeat' | 'routine' | 'dispatcher' | 'system';
}
