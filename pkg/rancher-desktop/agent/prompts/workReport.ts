/**
 * Work standup report — shared builder used by both the `work_report` CLI tool
 * and the one-time context injection into the orchestrating agent's first run
 * (see AgentNode). Read-only; builds from WorkItemsModel.
 *
 * "Done" = tasks whose completed_at falls in the look-back window. "Next" =
 * the top open tasks by priority → due → last moved.
 */

import { WorkItemsModel } from '../database/models/WorkItemsModel';

export interface WorkReportOpts {
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

export async function buildWorkReport(opts: WorkReportOpts = {}): Promise<string> {
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
    .sort((a, b) => Date.parse(b.completed_at as string) - Date.parse(a.completed_at as string));
  const doneEpics = epics.filter(e => e.status === 'done' && Date.parse(e.last_moved_at) >= cutoffMs);
  const doneProjects = projects.filter(p => p.status === 'done' && Date.parse(p.last_moved_at) >= cutoffMs);

  // NEXT
  const openRows = await WorkItemsModel.listTasks({ projectId, assignee, limit: 500 });
  const next = openRows.slice(0, nextLimit);

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
  lines.push(`## ▶️ Next up (${ next.length } of ${ openRows.length } open)`);
  if (!next.length) {
    lines.push('_No open tasks in scope._');
  } else {
    for (const t of next) {
      const due = t.due_at ? ` · due ${ fmt(t.due_at) }` : '';
      const who = t.assignee ? ` · ${ t.assignee }` : '';
      lines.push(`- [${ t.priority }] **${ t.title }** — ${ context(t) } · ${ t.status }${ due }${ who } (id ${ t.id })`);
    }
  }

  return lines.join('\n');
}
