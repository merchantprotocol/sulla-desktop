import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

function block(label: string, rec: Record<string, any>, extra: string[] = []): string {
  const keys = [
    'id', 'slug', 'title', 'status', 'priority', 'owner', 'assignee',
    'due_at', 'github_issue', 'parent_id', 'project_id', 'epic_id',
    'source', 'created_at', 'updated_at', 'last_moved_at', 'archived',
    ...extra,
  ];
  const lines = [`# ${ label }: ${ rec.title || rec.id }`];
  for (const k of keys) {
    if (rec[k] === undefined || rec[k] === null || rec[k] === '') continue;
    if (k === 'archived' && rec[k] === false) continue;
    lines.push(`${ k }: ${ Array.isArray(rec[k]) ? rec[k].join(', ') : rec[k] }`);
  }
  if (rec.description) {
    lines.push('', rec.description);
  }
  return lines.join('\n');
}

/**
 * Fetch one project item + its children / comments.
 */
export class GetWorkItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return { successBoolean: false, responseString: 'id is required.' };
    const hint = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';

    try {
      await WorkItemsModel.ensureTables();

      const tryKinds = hint ? [hint] : ['task', 'epic', 'project'];
      for (const kind of tryKinds) {
        if (kind === 'project') {
          const p = await WorkItemsModel.getProject(id);
          if (!p) continue;
          const epics = await WorkItemsModel.listEpics({ projectId: p.id, includeDone: true, limit: 100 });
          const parts = [block('Project', p)];
          parts.push('', `${ epics.length } epic(s):`);
          for (const e of epics) {
            parts.push(`- [${ e.id }] ${ e.priority } ${ e.status } ${ e.title }`);
          }
          return { successBoolean: true, responseString: parts.join('\n') };
        }
        if (kind === 'epic') {
          const e = await WorkItemsModel.getEpic(id);
          if (!e) continue;
          const tasks = await WorkItemsModel.listTasks({ epicId: e.id, includeDone: true, limit: 200 });
          const parts = [block('Epic', e)];
          parts.push('', `${ tasks.length } task(s):`);
          for (const t of tasks) {
            const nest = t.parent_id ? ` └ ${ t.parent_id }` : '';
            parts.push(`- [${ t.id }] ${ t.priority } ${ t.status } ${ t.title }${ nest }`);
          }
          return { successBoolean: true, responseString: parts.join('\n') };
        }
        if (kind === 'task') {
          const t = await WorkItemsModel.getTask(id);
          if (!t) continue;
          const comments = await WorkItemsModel.listComments(t.id);
          const subs = await WorkItemsModel.listTasks({ parentId: t.id, includeDone: true, limit: 100 });
          const parts = [block('Task', t, ['labels'])];
          if (subs.length) {
            parts.push('', `${ subs.length } subtask(s):`);
            for (const s of subs) parts.push(`- [${ s.id }] ${ s.priority } ${ s.status } ${ s.title }`);
          }
          if (comments.length) {
            parts.push('', `${ comments.length } comment(s):`);
            for (const c of comments) {
              parts.push(`- [${ c.id }] ${ c.author } @ ${ c.created_at}`);
              parts.push(`  ${ c.body.replace(/\n/g, '\n  ') }`);
            }
          }
          return { successBoolean: true, responseString: parts.join('\n') };
        }
      }

      return { successBoolean: false, responseString: `No project item found with id: ${ id }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Get project item failed: ${ err?.message }` };
    }
  }
}
