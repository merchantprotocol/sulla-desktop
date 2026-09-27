/**
 * Heartbeat idea lab digest.
 *
 * Every Heartbeat wake starts a fresh model session, so without a durable
 * record it re-reads the same board, finds the same gated work, and reports
 * "nothing changed" wake after wake. The idea lab (Projects project slug
 * 'heartbeat-idea-lab') is where Heartbeat records each idea and experiment.
 * This module builds a compact, zero-LLM digest of that lab plus a stagnation
 * signal, injected on every fresh wake so the model knows what it already
 * tried and whether it has gone quiet.
 */
import { WorkItemsModel, type WorkTaskRecord } from '../database/models/WorkItemsModel';

export const IDEA_LAB_PROJECT_SLUG = 'heartbeat-idea-lab';

/** No new idea for this long means Heartbeat has stopped inventing. */
export const STAGNATION_NO_NEW_IDEA_MS = 2 * 60 * 60_000;
/** No Heartbeat-authored Projects write for this long means it has gone idle. */
export const STAGNATION_NO_WRITE_MS = 60 * 60_000;

const RECENT_IDEA_LIMIT = 20;
const CLOSED_STATUSES = new Set(['done', 'cancelled', 'canceled', 'parked', 'archived']);

export interface IdeaLabDigestInput {
  nowMs:                number;
  project:              { id: string; title: string } | null;
  tasks:                WorkTaskRecord[];
  lastHeartbeatWriteAt: string | null;
}

function ageLabel(fromIso: string | null | undefined, nowMs: number): string {
  const at = fromIso ? Date.parse(fromIso) : NaN;
  if (Number.isNaN(at)) return 'never';
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 60) return `${ minutes }m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${ hours }h ago`;
  return `${ Math.round(hours / 24) }d ago`;
}

function lastTouchedMs(task: WorkTaskRecord): number {
  const stamps = [task.last_activity_at, task.updated_at, task.last_moved_at, task.created_at]
    .map(value => (value ? Date.parse(String(value)) : NaN))
    .filter(value => !Number.isNaN(value));
  return stamps.length ? Math.max(...stamps) : 0;
}

function isClosed(task: WorkTaskRecord): boolean {
  return Boolean(task.completed_at) || CLOSED_STATUSES.has(String(task.status || '').toLowerCase());
}

function hasLabel(task: WorkTaskRecord, label: string): boolean {
  return (task.labels || []).some(value => String(value).toLowerCase() === label);
}

/** Pure formatter — exported for tests. */
export function formatIdeaLabDigest(input: IdeaLabDigestInput): string {
  const { nowMs, project, tasks, lastHeartbeatWriteAt } = input;
  const lines: string[] = [];
  const alerts: string[] = [];

  const lastWriteMs = lastHeartbeatWriteAt ? Date.parse(lastHeartbeatWriteAt) : NaN;
  if (Number.isNaN(lastWriteMs) || nowMs - lastWriteMs >= STAGNATION_NO_WRITE_MS) {
    alerts.push(`no Heartbeat-authored Projects write for ${ ageLabel(lastHeartbeatWriteAt, nowMs).replace(' ago', '') }`);
  }

  if (!project) {
    alerts.push('the idea lab does not exist yet');
    lines.push(`No idea lab yet. Create the Projects project with slug '${ IDEA_LAB_PROJECT_SLUG }' (title "Heartbeat Idea Lab", owner heartbeat) before brainstorming.`);
  } else {
    const sorted = [...tasks].sort((a, b) => lastTouchedMs(b) - lastTouchedMs(a));
    const newestCreated = tasks.reduce<string | null>((latest, task) => {
      if (!task.created_at) return latest;
      return !latest || Date.parse(task.created_at) > Date.parse(latest) ? task.created_at : latest;
    }, null);
    const open = tasks.filter(task => !isClosed(task));
    const live = open.filter(task => hasLabel(task, 'experiment'));
    const wins = tasks.filter(task => hasLabel(task, 'win'));
    const losses = tasks.filter(task => hasLabel(task, 'loss'));

    if (!newestCreated || nowMs - Date.parse(newestCreated) >= STAGNATION_NO_NEW_IDEA_MS) {
      alerts.push(`no new idea logged for ${ ageLabel(newestCreated, nowMs).replace(' ago', '') }`);
    }

    lines.push(`Idea lab: ${ project.title } (project ${ project.id }, slug ${ IDEA_LAB_PROJECT_SLUG })`);
    lines.push(`Ideas: ${ tasks.length } total · ${ open.length - live.length } untried · ${ live.length } live experiments · ${ wins.length } wins · ${ losses.length } losses`);
    lines.push(`Last new idea: ${ ageLabel(newestCreated, nowMs) } · Last Heartbeat Projects write: ${ ageLabel(lastHeartbeatWriteAt, nowMs) }`);

    if (sorted.length === 0) {
      lines.push('The lab is empty. Brainstorm and log your first ideas.');
    } else {
      lines.push('', `Most recent ideas (newest first, ${ Math.min(sorted.length, RECENT_IDEA_LIMIT) } of ${ sorted.length }) — do not repeat these; build on their results:`);
      for (const task of sorted.slice(0, RECENT_IDEA_LIMIT)) {
        const labels = (task.labels || []).length ? ` [${ (task.labels || []).join(', ') }]` : '';
        lines.push(`- (${ task.status }) ${ task.title }${ labels } — id ${ task.id }, touched ${ ageLabel(new Date(lastTouchedMs(task)).toISOString(), nowMs) }`);
      }
    }
  }

  if (alerts.length) {
    lines.unshift(`STAGNATION ALERT: ${ alerts.join('; ') }. Brainstorming and running a new experiment is mandatory this wake.`, '');
  }

  return lines.join('\n');
}

/** Load the lab and recent Heartbeat activity, then format the digest. */
export async function buildIdeaLabDigest(nowMs = Date.now()): Promise<string> {
  const project = await WorkItemsModel.getProjectBySlug(IDEA_LAB_PROJECT_SLUG);
  const [tasks, activity] = await Promise.all([
    project ? WorkItemsModel.listTasks({ projectId: project.id, includeDone: true, limit: 200 }) : Promise.resolve([]),
    WorkItemsModel.listRecentActivity({ author: 'heartbeat', limit: 1 }),
  ]);

  return formatIdeaLabDigest({
    nowMs,
    project:              project && !project.archived ? { id: project.id, title: project.title } : null,
    tasks,
    lastHeartbeatWriteAt: activity[0]?.activity_at ?? null,
  });
}
