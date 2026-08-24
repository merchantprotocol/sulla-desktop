import { WorkItemsModel, type WorkTaskRecord } from './WorkItemsModel';
import { WorkTaskDependencyModel, type UnresolvedDependency } from './WorkTaskDependencyModel';
import { WorkTaskDispatchModel } from './WorkTaskDispatchModel';
import { WorkTaskWaitModel, type WorkTaskWaitRecord } from './WorkTaskWaitModel';
import { postgresClient } from '../PostgresClient';

export type ReadinessReasonType =
  | 'unmet_prerequisite'
  | 'downstream_backpressure'
  | 'external_wait'
  | 'worker_lease'
  | 'stage_wip'
  | 'human_gate';

export interface ReadinessBlockReason {
  type: ReadinessReasonType;
  message: string;
  unevaluated?: boolean;
  details?: Record<string, unknown>;
}

export interface ReadinessCapabilities {
  prerequisites: 'live' | 'pending';
  external_waits: 'live' | 'pending';
  worker_leases: 'live' | 'pending';
  stage_wip: 'live' | 'pending';
  human_gates: 'live' | 'pending';
}

export interface TaskReadiness {
  taskId: string;
  title: string;
  status: string;
  claimable: boolean;
  reasons: ReadinessBlockReason[];
  capabilities: ReadinessCapabilities;
}

export interface ReadinessFrontier {
  tasks: TaskReadiness[];
  capabilities: ReadinessCapabilities;
  evaluatedAt: string;
}

const DEFAULT_WIP_LIMIT = 6;
const DEFAULT_REVIEW_LIMIT = 3;
const HUMAN_LABELS = new Set(['gated', 'human', 'manual', 'no-auto-dispatch']);

function dependencyReason(unresolved: UnresolvedDependency): ReadinessBlockReason {
  return {
    type: 'unmet_prerequisite',
    message: unresolved.reason,
    details: {
      prerequisiteTaskId: unresolved.dependsOnTaskId,
      prerequisiteStatus: unresolved.dependsOnStatus,
      policy: unresolved.policy,
    },
  };
}

function waitReason(wait: WorkTaskWaitRecord): ReadinessBlockReason {
  return {
    type: 'external_wait',
    message: `Task is waiting on ${ wait.wait_kind }: ${ wait.target_key }`,
    details: { waitId: wait.id, targetKey: wait.target_key, status: wait.status, dueAt: wait.due_at },
  };
}

export function classifyHumanGate(task: Pick<WorkTaskRecord, 'assignee' | 'labels'>): ReadinessBlockReason | null {
  const labels = (task.labels ?? []).map(label => label.toLowerCase());
  if (task.assignee?.toLowerCase() === 'human' || labels.some(label => HUMAN_LABELS.has(label))) {
    return {
      type: 'human_gate',
      message: 'Task is explicitly owned or gated by a human.',
      details: { assignee: task.assignee, labels: task.labels ?? [] },
    };
  }
  return null;
}

export class ProjectReadinessModel {
  static async explainBlocked(taskId: string): Promise<TaskReadiness> {
    const task = await WorkItemsModel.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${ taskId }`);
    return this.evaluate(task);
  }

  static async ready(opts: { projectId?: string; limit?: number } = {}): Promise<ReadinessFrontier> {
    const tasks = await WorkItemsModel.listTasks({
      projectId: opts.projectId,
      semanticRoles: ['execution'],
      includeDone: false,
      limit: Math.max(1, Math.min(200, opts.limit ?? 50)),
    });
    const evaluations = await Promise.all(tasks
      .filter(task => task.status !== 'in_progress')
      .map(task => this.evaluate(task)));
    const capabilities = this.capabilities();
    return {
      tasks: evaluations.filter(task => task.claimable),
      capabilities,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private static capabilities(): ReadinessCapabilities {
    return {
      prerequisites: 'live',
      external_waits: 'live',
      worker_leases: 'live',
      stage_wip: 'live',
      human_gates: 'live',
    };
  }

  private static async evaluate(task: WorkTaskRecord): Promise<TaskReadiness> {
    const reasons: ReadinessBlockReason[] = [];
    const unresolved = await WorkTaskDependencyModel.listUnresolvedDependencies(task.id);
    reasons.push(...unresolved.map(dependencyReason));

    const waits = await WorkTaskWaitModel.list({ taskId: task.id, status: 'active', limit: 50 });
    reasons.push(...waits.map(waitReason));

    const lease = await postgresClient.queryOne<{ id: string; agent_id: string; kind: string }>(
      `SELECT id, agent_id, kind FROM work_task_dispatches WHERE task_id = $1 AND status = 'running' LIMIT 1`,
      [task.id],
    );
    if (lease) {
      reasons.push({
        type: 'worker_lease',
        message: `Task already has a live ${ lease.kind } lease held by ${ lease.agent_id }.`,
        details: { dispatchId: lease.id, agentId: lease.agent_id, kind: lease.kind },
      });
    }

    const humanGate = classifyHumanGate(task);
    if (humanGate) reasons.push(humanGate);

    const [running, reviewBacklog] = await Promise.all([
      WorkTaskDispatchModel.countRunning('execution'),
      WorkTaskDispatchModel.countReviewBacklog(),
    ]);
    if (task.status === 'todo' && running >= DEFAULT_WIP_LIMIT) {
      reasons.push({
        type: 'stage_wip',
        message: `Execution WIP limit reached (${ running }/${ DEFAULT_WIP_LIMIT }).`,
        details: { activeExecutionWip: running, wipLimit: DEFAULT_WIP_LIMIT },
      });
    }
    if (task.status === 'todo' && reviewBacklog >= DEFAULT_REVIEW_LIMIT) {
      reasons.push({
        type: 'downstream_backpressure',
        message: `Review backlog is applying downstream backpressure (${ reviewBacklog }/${ DEFAULT_REVIEW_LIMIT }).`,
        details: { reviewBacklog, reviewLimit: DEFAULT_REVIEW_LIMIT },
      });
    }

    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      claimable: reasons.length === 0,
      reasons,
      capabilities: this.capabilities(),
    };
  }
}
