import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

function fmtProject(p: any): string {
  return `[project ${ p.id }] ${ p.priority } ${ p.status } ${ p.title } (slug: ${ p.slug }${ p.due_at ? `, due ${ p.due_at }` : '' }${ p.owner ? `, owner ${ p.owner }` : '' }) moved ${ p.last_moved_at }`;
}
function fmtEpic(e: any): string {
  return `[epic ${ e.id }] ${ e.priority } ${ e.status } ${ e.title } (project: ${ e.project_id }${ e.due_at ? `, due ${ e.due_at }` : '' }) moved ${ e.last_moved_at }`;
}
function fmtTask(t: any): string {
  const labels = Array.isArray(t.labels) && t.labels.length ? ` [${ t.labels.join(',') }]` : '';
  const nest = t.parent_id ? ` subtask-of ${ t.parent_id }` : '';
  return `[task ${ t.id }] ${ t.priority } ${ t.status } ${ t.title }${ labels } (epic: ${ t.epic_id }${ nest }${ t.assignee ? `, @${ t.assignee }` : '' }${ t.due_at ? `, due ${ t.due_at }` : '' }${ t.github_issue ? `, ${ t.github_issue }` : '' }) moved ${ t.last_moved_at }`;
}

/**
 * List Projects work-state from Postgres.
 */
export class ListWorkItemsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = String(input.kind || 'task').toLowerCase();
    const limit = Number(input.limit) || 50;
    const includeDone = Boolean(input.include_done ?? input.includeDone ?? false);
    const status = input.status || undefined;
    const priority = input.priority || undefined;
    const projectId = input.project_id || undefined;
    const epicId = input.epic_id || undefined;
    const parentId = input.parent_id || undefined;
    const assignee = input.assignee || undefined;

    try {
      await WorkItemsModel.ensureTables();
      const lines: string[] = [];

      if (kind === 'project' || kind === 'all') {
        const rows = await WorkItemsModel.listProjects({ status, priority, includeDone, limit });
        lines.push(rows.length ? `${ rows.length } project(s):` : 'No projects.');
        lines.push(...rows.map(fmtProject));
      }
      if (kind === 'epic' || kind === 'all') {
        const rows = await WorkItemsModel.listEpics({ projectId, status, priority, includeDone, limit });
        if (lines.length) lines.push('');
        lines.push(rows.length ? `${ rows.length } epic(s):` : 'No epics.');
        lines.push(...rows.map(fmtEpic));
      }
      if (kind === 'task' || kind === 'all') {
        const rows = await WorkItemsModel.listTasks({
          projectId, epicId, parentId, status, priority, assignee, includeDone, limit,
        });
        if (lines.length) lines.push('');
        lines.push(rows.length ? `${ rows.length } task(s):` : 'No tasks.');
        lines.push(...rows.map(fmtTask));
      }
      if (!['project', 'epic', 'task', 'all'].includes(kind)) {
        return { successBoolean: false, responseString: `Unknown kind "${ kind }". Use project, epic, task, or all.` };
      }

      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err: any) {
      return { successBoolean: false, responseString: `List work items failed: ${ err?.message }` };
    }
  }
}
