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
import { WorkTaskDependencyModel } from '../database/models/WorkTaskDependencyModel';
import { WorkTaskWaitModel, type WorkTaskWaitRecord } from '../database/models/WorkTaskWaitModel';

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

  return `${ d.toISOString().slice(0, 16).replace('T', ' ') } UTC`;
}

function waitTiming(wait: WorkTaskWaitRecord, monitorEnabled: boolean): string {
  const technicalCheck = `technical next_check_at ${ fmt(wait.next_check_at) }`;

  switch (wait.wait_kind) {
  case 'external_job':
    return `awaiting external event or explicit adapter · ${ technicalCheck } (not a scheduled provider poll)`;
  case 'human_gate':
    return `${ wait.due_at ? `awaiting human approval · due ${ fmt(wait.due_at) }` : 'awaiting human approval (no deadline)' } · ${ technicalCheck }`;
  case 'scheduled_time':
    return `scheduled deadline ${ wait.due_at ? fmt(wait.due_at) : 'not set' } · ${ technicalCheck }`;
  case 'github_checks':
    return `${ monitorEnabled ? 'next poll' : 'stored next poll (monitor disabled)' } ${ fmt(wait.next_check_at) }`;
  }
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

  const context = (t: { project_id: string; epic_id: string | null }): string => {
    const proj = projectTitle.get(t.project_id) ?? t.project_id;
    const epic = t.epic_id ? (epicTitle.get(t.epic_id) ?? t.epic_id) : '—';

    return `${ shorten(proj) } › ${ shorten(epic) }`;
  };

  // DONE in window
  const doneRows = await WorkItemsModel.listTasks({ projectId, assignee, includeDone: true, limit: 3000 });
  const completed = doneRows
    .filter(t => (t.status === 'done' || t.status === 'cancelled') && t.completed_at && Date.parse(t.completed_at) >= cutoffMs)
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
    t.status !== 'blocked' && t.status !== 'planning' && !dependencyHeldIds.has(t.id) &&
      (!suppressionEnabled || !activeWaitIds.has(t.id)),
  );
  const blockedRows = openRows.filter(t => t.status === 'blocked');
  const planningRows = openRows.filter(t => t.status === 'planning');
  const next = actionableRows.slice(0, nextLimit);
  const blocked = blockedRows.slice(0, nextLimit);
  const planning = planningRows.slice(0, nextLimit);

  const lines: string[] = [];
  const scope = [projectId ? `project ${ projectId }` : null, assignee ? `assignee ${ assignee }` : null]
    .filter(Boolean).join(', ');
  lines.push(`# Project report — last ${ hours }h${ scope ? ` (${ scope })` : '' }`);

  // Human comments outrank every queue below and ignore lane scope: the human
  // asked for a look, whatever state the ticket is in.
  if (opts.lifecycleAware) {
    const { listHumanCommentTriage } = await import('../services/HumanCommentTriage');
    const awaiting = await listHumanCommentTriage();
    if (awaiting.length) {
      lines.push('');
      lines.push(`## 💬 Human comments awaiting your reply (${ awaiting.length })`);
      lines.push('_Handle these first, oldest first, regardless of lane, lifecycle owner, parked/blocked/done state or dependencies. Open the ticket, read the comment in context, then either change the ticket as asked, move it to its execution lane so the dispatcher picks it up, or answer the question. Finish every one with add_task_comment author="heartbeat" saying what you decided and did — that reply clears it from this list. Tickets with a live worker claim are held back until the claim ends._');
      for (const row of awaiting) {
        const excerpt = row.body.replace(/\s+/g, ' ').trim();
        lines.push(`- **${ row.task.title }** — ${ context(row.task) } · ${ row.task.status } · commented ${ fmt(row.created_at) }: "${ excerpt.length > 280 ? `${ excerpt.slice(0, 279) }…` : excerpt }" (id ${ row.task.id })`);
      }
    }
  }

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
    : '_Task selection, admission, assignment, retries, and recovery belong to the mechanical dispatcher. This report is context, not permission for Heartbeat or another LLM to dispatch portfolio workers. Workers execute only their already-claimed task; do not create a second dispatch path._');
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
  lines.push(!monitorEnabled
    ? '_Monitor disabled: stored wait dates do not imply active checks; actionable filtering/comment suppression is disabled._'
    : suppressionEnabled
      ? '_These waits are omitted from actionable work until a material delta reactivates them. Heartbeat must not poll or comment on unchanged waits._'
      : '_Shadow mode: monitor decisions are recorded, but actionable filtering/comment suppression is not enabled yet._');
  for (const wait of scopedActiveWaits.slice(0, nextLimit)) {
    lines.push(`- **${ wait.wait_kind }** ${ wait.target_key } · task ${ wait.task_id } · ${ waitTiming(wait, monitorEnabled) } · unchanged ${ wait.consecutive_unchanged_count }`);
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
