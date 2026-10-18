/**
 * Project standup report — shared builder used by both the `project_report` CLI tool
 * and the one-time context injection into the orchestrating agent's first run
 * (see AgentNode). Read-only; builds through the Projects service boundary.
 *
 * "Done" = tasks whose completed_at falls in the look-back window. Open work
 * is split into actionable, planning, and blocked queues. Within a priority
 * block the least-recently-active task comes first, producing deterministic
 * round-robin rotation whenever an agent edits or comments on a task.
 */

import { getProjectsApplicationService } from '../projects/application/ProjectsApplicationService';

export interface ProjectReportOpts {
  hours?:                number;
  nextLimit?:            number;
  projectId?:            string;
  assignee?:             string;
  /** Lead with human comments awaiting a Heartbeat reply (Heartbeat's own report). */
  includeHumanComments?: boolean;
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

export async function buildProjectReport(opts: ProjectReportOpts = {}): Promise<string> {
  const hours = typeof opts.hours === 'number' && opts.hours > 0 ? opts.hours : 24;
  const nextLimit = typeof opts.nextLimit === 'number' && opts.nextLimit > 0 ? opts.nextLimit : 15;
  const projectId = opts.projectId?.trim() || undefined;
  const assignee = opts.assignee?.trim() || undefined;
  const cutoffMs = Date.now() - (hours * 60 * 60 * 1000);

  const projectsService = getProjectsApplicationService();
  await projectsService.ready();

  const [projects, epics] = await Promise.all([
    projectsService.listProjects({ includeDone: true, limit: 500 }),
    projectsService.listEpics({ includeDone: true, limit: 2000 }),
  ]);
  const projectTitle = new Map(projects.map(p => [p.id, p.title]));
  const epicTitle = new Map(epics.map(e => [e.id, e.title]));

  const context = (t: { project_id: string; epic_id: string | null }): string => {
    const proj = projectTitle.get(t.project_id) ?? t.project_id;
    const epic = t.epic_id ? (epicTitle.get(t.epic_id) ?? t.epic_id) : '—';

    return `${ shorten(proj) } › ${ shorten(epic) }`;
  };

  // DONE in window
  const doneRows = await projectsService.listTasks({ projectId, assignee, includeDone: true, limit: 3000 });
  const completed = doneRows
    .filter(t => (t.status === 'done' || t.status === 'cancelled') && t.completed_at && Date.parse(t.completed_at) >= cutoffMs)
    .sort((a, b) => Date.parse(b.completed_at!) - Date.parse(a.completed_at!));
  const doneEpics = epics.filter(e => e.status === 'done' && Date.parse(e.last_moved_at) >= cutoffMs);
  const doneProjects = projects.filter(p => p.status === 'done' && Date.parse(p.last_moved_at) >= cutoffMs);

  // OPEN QUEUES — Projects already orders by epic priority → task
  // priority → oldest activity. Preserve that order while separating states.
  const openRows = await projectsService.listTasks({ projectId, assignee, limit: 500 });
  const readiness = await Promise.all([...new Set(openRows.map(task => task.project_id))]
    .map(currentProjectId => projectsService.readyTasks({ projectId: currentProjectId, limit: 500 })));
  const openIds = new Set(openRows.map(task => task.id));
  const dependencyHolds = readiness.flatMap(result => result.blocked)
    .filter(row => openIds.has(row.task.id))
    .flatMap(row => row.holds);
  const dependencyHeldIds = new Set(dependencyHolds.map(hold => hold.taskId));
  const actionableRows = openRows.filter(t =>
    t.status !== 'blocked' && t.status !== 'planning' && !dependencyHeldIds.has(t.id),
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
  if (opts.includeHumanComments) {
    const { listHumanCommentTriage } = await import('../services/HumanCommentTriage');
    const awaiting = await listHumanCommentTriage();
    if (awaiting.length) {
      lines.push('');
      lines.push(`## 💬 Human comments awaiting your reply (${ awaiting.length })`);
      lines.push('_Handle these first, oldest first, regardless of lane, parked/blocked/done state or dependencies. Open the ticket, read the comment in context, then change the ticket as asked, tell the project\'s assigned agent, or answer the question. Finish every one with add_task_comment author="heartbeat" saying what you decided and did — that reply clears it from this list._');
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
  lines.push(`## ▶️ Open now (${ next.length } of ${ actionableRows.length })`);
  lines.push('_Projects is a plain board. The account manager launches each stage: the project manager (the project\'s assigned agent) plans the board and the director drives the work; the app never claims or launches tasks. Work a task only when it is assigned to you or you were asked to._');
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
  lines.push('_These tasks wait on a prerequisite that is not done yet. Finish or remove the prerequisite first._');
  for (const taskId of [...dependencyHeldIds].slice(0, nextLimit)) {
    const task = openRows.find(row => row.id === taskId);
    const reasons = dependencyHolds.filter(hold => hold.taskId === taskId)
      .map(hold => `${ hold.dependsOnTaskId } (${ hold.dependsOnStatus ?? hold.policy })`).join(', ');
    lines.push(`- **${ task?.title ?? taskId }** · blocked by ${ reasons } (id ${ taskId })`);
  }

  lines.push('');
  lines.push(`## 🧭 Blocked tasks (${ blocked.length } of ${ blockedRows.length })`);
  lines.push('_Each needs its owner (the assignee or the project\'s assigned agent) to clear the blocker or re-plan it._');
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
    lines.push(`## 🛠 In planning (${ planning.length } of ${ planningRows.length })`);
    for (const t of planning) {
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) }${ who } (id ${ t.id })`);
    }
  }

  return lines.join('\n');
}
