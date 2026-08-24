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
import { WorkItemsModel } from '../database/models/WorkItemsModel';

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
  const actionableRows = openRows.filter(t => t.status !== 'blocked' && t.status !== 'planning');
  const blockedRows = openRows.filter(t => t.status === 'blocked');
  const planningRows = openRows.filter(t => t.status === 'planning');
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
  lines.push(opts.lifecycleAware
    ? `## 🧭 Explicit Heartbeat planning fallback (${ blocked.length } of ${ blockedRows.length })`
    : `## 🧭 Blocked tasks — recovery planning (${ blocked.length } of ${ blockedRows.length })`);
  lines.push(opts.lifecycleAware
    ? '_These rows are available only because the planning-capability contract explicitly names Heartbeat as fallback._'
    : '_These are recovery-planning work, not a human review queue. After dispatching across actionable tasks, Heartbeat should use remaining capacity on the oldest blocked task in the highest priority block: move it to `planning` and dispatch a council of independent high-reasoning planners. Cross-check their proposals, choose the strongest reversible path, record the decision, move the task to `in_progress`, and execute it. Escalate only a genuinely irreversible/high-blast action after staging the reversible work. If no execution path exists, return it to `blocked`; the new activity rotates it to the bottom of its priority block._');
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
    lines.push('_Do not dispatch these again. A planning agent already owns the recovery pass._');
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
