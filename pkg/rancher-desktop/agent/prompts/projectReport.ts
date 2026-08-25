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

import { LifecycleCapabilityModel } from '../database/models/LifecycleCapabilityModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { WorkItemsModel } from '../database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '../database/models/WorkLaneDefinitionModel';
import { WorkTaskDependencyModel } from '../database/models/WorkTaskDependencyModel';
import { WorkTaskWaitModel } from '../database/models/WorkTaskWaitModel';

export interface ProjectReportOpts {
  hours?:          number;
  nextLimit?:      number;
  projectId?:      string;
  assignee?:       string;
  lifecycleAware?: boolean;
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
  const laneEntries = await Promise.all(projects.map(async project => [
    project.id,
    await WorkLaneDefinitionModel.resolveEffective(project.id),
  ] as const));
  const laneMaps = new Map(laneEntries.map(([id, lanes]) => [
    id, new Map(lanes.map(lane => [lane.lane_key, lane])),
  ]));
  const laneFor = (task: { project_id: string; status: string }) =>
    laneMaps.get(task.project_id)?.get(task.status);

  const context = (t: { project_id: string; epic_id: string | null }): string => {
    const proj = projectTitle.get(t.project_id) ?? t.project_id;
    const epic = t.epic_id ? (epicTitle.get(t.epic_id) ?? t.epic_id) : '—';

    return `${ shorten(proj) } › ${ shorten(epic) }`;
  };

  // DONE in window
  const doneRows = await WorkItemsModel.listTasks({ projectId, assignee, includeDone: true, limit: 3000 });
  const completed = doneRows
    .filter(task => laneFor(task)?.semantic_role === 'terminal' && task.completed_at && Date.parse(task.completed_at) >= cutoffMs)
    .sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!));
  const doneEpics = epics.filter(e => e.status === 'done' && Date.parse(e.last_moved_at) >= cutoffMs);
  const doneProjects = projects.filter(p => p.status === 'done' && Date.parse(p.last_moved_at) >= cutoffMs);

  // OPEN QUEUES — WorkItemsModel already orders by epic priority → task
  // priority → oldest activity. Preserve that order while separating states.
  const listedOpenRows = await WorkItemsModel.listTasks({ projectId, assignee, limit: 500 });
  const lifecycleAccess = opts.lifecycleAware
    ? await LifecycleCapabilityModel.heartbeatAccessByTask(listedOpenRows)
    : null;
  const openRows = lifecycleAccess
    ? listedOpenRows.filter(task => ['heartbeat_fallback', 'unmanaged'].includes(lifecycleAccess.get(task.id)?.mode ?? 'manual_hold'))
    : listedOpenRows;
  const lifecycleOwnedRows = lifecycleAccess
    ? listedOpenRows.filter(task => !['heartbeat_fallback', 'unmanaged'].includes(lifecycleAccess.get(task.id)?.mode ?? 'manual_hold'))
    : [];
  const [activeWaitIds, activeWaits, suppressionConfigured, monitorEnabled, dependencyHolds] = await Promise.all([
    WorkTaskWaitModel.activeTaskIds(),
    WorkTaskWaitModel.list({ status: 'active', limit: 500 }),
    SullaSettingsModel.get('externalWaitCommentSuppressionEnabled', false),
    SullaSettingsModel.get('externalWaitMonitorEnabled', true),
    WorkTaskDependencyModel.listUnresolvedForTasks(openRows.map(task => task.id)),
  ]);
  const suppressionEnabled = monitorEnabled && suppressionConfigured;
  const scopedTaskIds = new Set(openRows.map(task => task.id));
  const scopedActiveWaits = activeWaits.filter(wait => scopedTaskIds.has(wait.task_id));
  const dependencyHeldIds = new Set(dependencyHolds.map(hold => hold.taskId));
  const actionableRows = openRows.filter(t =>
    !['blocked', 'planning', 'terminal'].includes(laneFor(t)?.semantic_role ?? 'manual') && !dependencyHeldIds.has(t.id) &&
      (!suppressionEnabled || !activeWaitIds.has(t.id)),
  );
  const blockedRows = openRows.filter(t => laneFor(t)?.semantic_role === 'blocked');
  const planningRows = openRows.filter(t => laneFor(t)?.semantic_role === 'planning');
  const next = actionableRows.slice(0, nextLimit);
  const blocked = blockedRows.slice(0, nextLimit);
  const planning = planningRows.slice(0, nextLimit);

  const lines: string[] = [];
  const scope = [projectId ? `project ${ projectId }` : null, assignee ? `assignee ${ assignee }` : null]
    .filter(Boolean).join(', ');
  lines.push(`# Project report — last ${ hours }h${ scope ? ` (${ scope })` : '' }`);

  lines.push('');
  lines.push(`## ✅ Completed (${ completed.length })`);
  if (!completed.length) {
    lines.push('_Nothing marked done in this window._');
  } else {
    for (const t of completed) {
      lines.push(`- **${ t.title }** — ${ context(t) } · ${ t.status } · ${ fmt(t.completed_at) } (id ${ t.id })`);
    }
  }
  for (const e of doneEpics) lines.push(`- _(epic)_ **${ e.title }** completed · ${ shorten(projectTitle.get(e.project_id) ?? e.project_id) } (id ${ e.id })`);
  for (const p of doneProjects) lines.push(`- _(project)_ **${ p.title }** completed (id ${ p.id })`);

  lines.push('');
  lines.push(opts.lifecycleAware
    ? `## ▶️ Explicit Heartbeat fallback (${ next.length } of ${ actionableRows.length })`
    : `## ▶️ Actionable now (${ next.length } of ${ actionableRows.length })`);
  lines.push(opts.lifecycleAware
    ? '_Only rows listed here have an explicit named Heartbeat fallback (or no lifecycle stage). Heartbeat may act within that fallback; absence or manual hold never grants ownership._'
    : '_This is a portfolio dispatch queue, not a one-task limit. Heartbeat should hydrate and dispatch as many independent tasks as available sub-agent capacity allows, one task per work agent, then continue across the queue for the full wake._');
  if (!next.length) {
    lines.push('_No open tasks in scope._');
  } else {
    for (const t of next) {
      const due = t.due_at ? ` · due ${ fmt(t.due_at) }` : '';
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) } · ${ t.status }${ due }${ who } (id ${ t.id })`);
    }
  }

  lines.push('');
  lines.push(`## 🔗 Dependency-held work (${ dependencyHeldIds.size })`);
  lines.push('_These tasks are mechanically excluded from planning, execution, review, and lane-entry claims. They are separate from external waits and human gates._');
  for (const taskId of [...dependencyHeldIds].slice(0, nextLimit)) {
    const task = openRows.find(row => row.id === taskId);
    const reasons = dependencyHolds.filter(hold => hold.taskId === taskId)
      .map(hold => `${ hold.dependsOnTaskId } (${ hold.dependsOnStatus ?? hold.policy })`).join(', ');
    lines.push(`- **${ task?.title ?? taskId }** · blocked by ${ reasons } (id ${ taskId })`);
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
  lines.push(opts.lifecycleAware
    ? `## 🧭 Explicit Heartbeat planning fallback (${ blocked.length } of ${ blockedRows.length })`
    : `## 🧭 Blocked tasks — recovery planning (${ blocked.length } of ${ blockedRows.length })`);
  lines.push(opts.lifecycleAware
    ? '_These rows are available only because the planning-capability contract explicitly names Heartbeat as fallback._'
    : '_These are recovery-planning work, not a human review queue. A committed transition to `blocked` or `planning` triggers the locked core planning routine, which owns the independent council, synthesis, final-plan comment, and return to `todo/dispatcher`. Heartbeat must not launch a second council; supervise failed/stale runs and verify the persisted plan._');
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

  if (lifecycleOwnedRows.length) {
    lines.push('');
    lines.push(`## 🔒 Protected lifecycle work — data only (${ lifecycleOwnedRows.length })`);
    lines.push('_Visibility is informational. Do not plan, execute, review, poll, reclaim, or mutate task status for these rows; the named capability owner and its live claim retain custody._');
    for (const task of lifecycleOwnedRows.slice(0, nextLimit)) {
      const access = lifecycleAccess?.get(task.id);
      const owner = access?.owner ?? 'manual hold';
      const claim = access?.liveClaim ? ` · live claim ${ access.liveClaim.id } by ${ access.liveClaim.owner }` : '';
      lines.push(`- [${ task.priority }] **${ task.title }** — ${ context(task) } · ${ task.status } · capability ${ access?.capabilityKey ?? 'none' } · owner ${ owner }${ claim } (id ${ task.id })`);
    }
  }

  return lines.join('\n');
}
