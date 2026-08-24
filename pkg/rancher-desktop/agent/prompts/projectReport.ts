/**
 * Project standup report — shared builder used by both the `project_report` CLI tool
 * and the one-time context injection into the orchestrating agent's first run
 * (see AgentNode). Read-only; builds from WorkItemsModel.
 *
 * "Done" = tasks whose completed_at falls in the look-back window. Open work
 * is split into actionable, planning, and blocked queues. Within a priority
 * block the least-recently-active task comes first, producing deterministic
 * round-robin rotation whenever an agent edits or comments on a task.
 */

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel } from '../database/models/WorkItemsModel';
import { WorkLaneDefinitionModel, type EffectiveWorkLane } from '../database/models/WorkLaneDefinitionModel';
import { WorkTaskWaitModel } from '../database/models/WorkTaskWaitModel';

export interface ProjectReportOpts {
  hours?:     number;
  nextLimit?: number;
  projectId?: string;
  assignee?:  string;
}

function shorten(s: string): string {
  const head = s.split(' (')[0].split(' — ')[0].trim();

  return head.length > 48 ? `${ head.slice(0, 47) }…` : head;
}

function fmt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  return `${ d.getMonth() + 1 }/${ d.getDate() } ${ String(d.getHours()).padStart(2, '0') }:${ String(d.getMinutes()).padStart(2, '0') }`;
}

export async function buildProjectReport(opts: ProjectReportOpts = {}): Promise<string> {
  const hours = typeof opts.hours === 'number' && opts.hours > 0 ? opts.hours : 24;
  const nextLimit = typeof opts.nextLimit === 'number' && opts.nextLimit > 0 ? opts.nextLimit : 15;
  const projectId = opts.projectId?.trim() || undefined;
  const assignee = opts.assignee?.trim() || undefined;
  const cutoffMs = Date.now() - (hours * 60 * 60 * 1000);

  await WorkItemsModel.ensureTables();

  const [projects, epics] = await Promise.all([
    WorkItemsModel.listProjects({ includeDone: true, limit: 500 }),
    WorkItemsModel.listEpics({ includeDone: true, limit: 2000 }),
  ]);
  const projectTitle = new Map(projects.map(p => [p.id, p.title]));
  const epicTitle = new Map(epics.map(e => [e.id, e.title]));
  const capability = await WorkLaneDefinitionModel.runtimeCapability(projectId);
  const laneSets = new Map<string, Map<string, EffectiveWorkLane>>();
  for (const id of new Set(projects.map(project => project.id))) {
    const lanes = capability.catalogPresent
      ? await WorkLaneDefinitionModel.resolveEffective(id).catch(() => [])
      : [];
    laneSets.set(id, new Map(lanes.map(lane => [lane.lane_key, lane])));
  }
  const laneFor = (task: { project_id: string; status: string }) => laneSets.get(task.project_id)?.get(task.status);
  const roleFor = (task: { project_id: string; status: string }) => {
    const role = laneFor(task)?.semantic_role;
    if (role) return role;
    if (task.status === 'planning' || task.status === 'blocked') return task.status;
    if (task.status === 'in_review') return 'review';
    if (task.status === 'done' || task.status === 'cancelled') return 'terminal';
    if (task.status === 'backlog') return 'backlog';
    if (task.status === 'todo' || task.status === 'in_progress') return 'execution';
    return 'manual';
  };

  const context = (t: { project_id: string; epic_id: string | null }): string => {
    const proj = projectTitle.get(t.project_id) ?? t.project_id;
    const epic = t.epic_id ? (epicTitle.get(t.epic_id) ?? t.epic_id) : '—';

    return `${ shorten(proj) } › ${ shorten(epic) }`;
  };

  // DONE in window
  const doneRows = await WorkItemsModel.listTasks({ projectId, assignee, includeDone: true, limit: 3000 });
  const completed = doneRows
    .filter(t => roleFor(t) === 'terminal' && t.completed_at && Date.parse(t.completed_at) >= cutoffMs)
    .sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!));
  const doneEpics = epics.filter(e => e.status === 'done' && Date.parse(e.last_moved_at) >= cutoffMs);
  const doneProjects = projects.filter(p => p.status === 'done' && Date.parse(p.last_moved_at) >= cutoffMs);

  // OPEN QUEUES — WorkItemsModel already orders by epic priority → task
  // priority → oldest activity. Preserve that order while separating states.
  const openRows = await WorkItemsModel.listTasks({ projectId, assignee, limit: 500 });
  const [activeWaitIds, activeWaits, suppressionConfigured, monitorEnabled] = await Promise.all([
    WorkTaskWaitModel.activeTaskIds(),
    WorkTaskWaitModel.list({ status: 'active', limit: 500 }),
    SullaSettingsModel.get('externalWaitCommentSuppressionEnabled', false),
    SullaSettingsModel.get('externalWaitMonitorEnabled', true),
  ]);
  const suppressionEnabled = monitorEnabled && suppressionConfigured;
  const scopedTaskIds = new Set(openRows.map(task => task.id));
  const scopedActiveWaits = activeWaits.filter(wait => scopedTaskIds.has(wait.task_id));
  const actionableRows = openRows.filter(t =>
    ['backlog', 'execution'].includes(roleFor(t)) && (!suppressionEnabled || !activeWaitIds.has(t.id)),
  );
  const blockedRows = openRows.filter(t => roleFor(t) === 'blocked');
  const planningRows = openRows.filter(t => roleFor(t) === 'planning');
  const reviewRows = openRows.filter(t => roleFor(t) === 'review');
  const manualRows = openRows.filter(t => roleFor(t) === 'manual');
  const next = actionableRows.slice(0, nextLimit);
  const blocked = blockedRows.slice(0, nextLimit);
  const planning = planningRows.slice(0, nextLimit);

  const lines: string[] = [];
  const scope = [projectId ? `project ${ projectId }` : null, assignee ? `assignee ${ assignee }` : null]
    .filter(Boolean).join(', ');
  lines.push(`# Project report — last ${ hours }h${ scope ? ` (${ scope })` : '' }`);
  if (!capability.ready) {
    lines.push('');
    lines.push(`> ⚠ Semantic lanes degraded: ${ capability.degradedReason ?? 'required capability unavailable' } Compatibility keys remain visible and active.`);
  }

  lines.push('');
  lines.push(`## ✅ Completed (${ completed.length })`);
  if (!completed.length) {
    lines.push('_Nothing marked done in this window._');
  } else {
    for (const t of completed) {
      lines.push(`- **${ t.title }** — ${ context(t) } · ${ laneFor(t)?.display_name ?? t.status } (terminal) · ${ fmt(t.completed_at) } (id ${ t.id })`);
    }
  }
  for (const e of doneEpics) lines.push(`- _(epic)_ **${ e.title }** completed · ${ shorten(projectTitle.get(e.project_id) ?? e.project_id) } (id ${ e.id })`);
  for (const p of doneProjects) lines.push(`- _(project)_ **${ p.title }** completed (id ${ p.id })`);

  lines.push('');
  lines.push(`## ▶️ Actionable now (${ next.length } of ${ actionableRows.length })`);
  lines.push('_This is a portfolio dispatch queue, not a one-task limit. Heartbeat should hydrate and dispatch as many independent tasks as available sub-agent capacity allows, one task per work agent, then continue across the queue for the full wake._');
  if (!next.length) {
    lines.push('_No open tasks in scope._');
  } else {
    for (const t of next) {
      const due = t.due_at ? ` · due ${ fmt(t.due_at) }` : '';
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) } · ${ laneFor(t)?.display_name ?? t.status } (${ roleFor(t) })${ due }${ who } (id ${ t.id })`);
    }
  }

  lines.push('');
  lines.push(`## ⏳ Monitor-owned external waits (${ scopedActiveWaits.length })`);
  lines.push(suppressionEnabled
    ? '_These waits are omitted from actionable work until a material delta reactivates them. Heartbeat must not poll or comment on unchanged waits._'
    : '_Shadow mode: monitor decisions are recorded, but actionable filtering/comment suppression is not enabled yet._');
  for (const wait of scopedActiveWaits.slice(0, nextLimit)) {
    lines.push(`- **${ wait.wait_kind }** ${ wait.target_key } · task ${ wait.task_id } · next ${ fmt(wait.next_check_at) } · unchanged ${ wait.consecutive_unchanged_count }`);
  }

  lines.push('');
  lines.push(`## 🧭 Blocked tasks — recovery planning (${ blocked.length } of ${ blockedRows.length })`);
  lines.push('_These are recovery-planning work, not a human review queue. A committed transition to `blocked` or `planning` triggers the locked core planning routine, which owns the independent council, synthesis, final-plan comment, and return to `todo/dispatcher`. Heartbeat must not launch a second council; supervise failed/stale runs and verify the persisted plan._');
  if (!blocked.length) {
    lines.push('_No blocked tasks in scope._');
  } else {
    for (const t of blocked) {
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) }${ who } (id ${ t.id })`);
    }
  }

  if (planningRows.length) {
    lines.push('');
    lines.push(`## 🛠 Planning in flight (${ planning.length } of ${ planningRows.length })`);
    lines.push('_Do not dispatch these again. The locked core routine already owns the task-scoped planning council._');
    for (const t of planning) {
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) }${ who } (id ${ t.id })`);
    }
  }

  if (reviewRows.length) {
    lines.push('');
    lines.push(`## 🔎 Review in flight (${ reviewRows.length })`);
    lines.push('_Owned by the resolved review workflow or compatibility verifier. Do not dispatch a duplicate review._');
    for (const t of reviewRows.slice(0, nextLimit)) {
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) } · ${ laneFor(t)?.display_name ?? t.status }${ who } (id ${ t.id })`);
    }
  }

  if (manualRows.length) {
    lines.push('');
    lines.push(`## ◻ Manual/custom lanes (${ manualRows.length })`);
    lines.push('_Visible for custody and human action; automation must not claim these tasks._');
    for (const t of manualRows.slice(0, nextLimit)) {
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) } · ${ laneFor(t)?.display_name ?? t.status }${ who } (id ${ t.id })`);
    }
  }

  return lines.join('\n');
}
