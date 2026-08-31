import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

import type { KnowledgeWorkItemKind } from '../../database/models/WorkItemKnowledgeModel';

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

async function knowledgeSummary(kind: KnowledgeWorkItemKind, id: string, enabled: boolean): Promise<string[]> {
  if (!enabled) return [];
  const rows = await getProjectsApplicationService().listKnowledgeForItem({
    itemKind: kind, itemId: id, includeInherited: true, limit: 20,
  });
  const lines = ['', `${ rows.length } linked knowledge item(s):`];
  for (const row of rows) {
    lines.push(`- [${ row.node_id }] ${ row.scope } ${ row.relation_type }: ${ row.title } (from ${ row.linked_item_kind } ${ row.linked_item_id })`);
  }
  return lines;
}

/**
 * Fetch one project item + its children / comments.
 */
export class GetProjectItemWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return { successBoolean: false, responseString: 'id is required.' };
    const hint = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const includeKnowledge = Boolean(input.include_knowledge ?? false);

    try {
      const projects = getProjectsApplicationService();
      await projects.ready();

      const tryKinds = hint ? [hint] : ['task', 'epic', 'project'];
      for (const kind of tryKinds) {
        if (kind === 'project') {
          const p = await projects.getProject(id);
          if (!p) continue;
          const epics = await projects.listEpics({ projectId: p.id, includeDone: true, limit: 100 });
          const parts = [block('Project', p)];
          parts.push('', `${ epics.length } epic(s):`);
          for (const e of epics) {
            parts.push(`- [${ e.id }] ${ e.priority } ${ e.status } ${ e.title }`);
          }
          parts.push(...await knowledgeSummary('project', p.id, includeKnowledge));
          return { successBoolean: true, responseString: parts.join('\n') };
        }
        if (kind === 'epic') {
          const e = await projects.getEpic(id);
          if (!e) continue;
          const tasks = await projects.listTasks({ epicId: e.id, includeDone: true, limit: 200 });
          const parts = [block('Epic', e)];
          parts.push('', `${ tasks.length } task(s):`);
          for (const t of tasks) {
            const nest = t.parent_id ? ` └ ${ t.parent_id }` : '';
            parts.push(`- [${ t.id }] ${ t.priority } ${ t.status } ${ t.title }${ nest }`);
          }
          parts.push(...await knowledgeSummary('epic', e.id, includeKnowledge));
          return { successBoolean: true, responseString: parts.join('\n') };
        }
        if (kind === 'task') {
          const t = await projects.getTask(id);
          if (!t) continue;
          const comments = await projects.listComments(t.id);
          const subs = await projects.listTasks({ parentId: t.id, includeDone: true, limit: 100 });
          const parts = [block('Task', t, ['labels'])];
          if (subs.length) {
            parts.push('', `${ subs.length } subtask(s):`);
            for (const s of subs) parts.push(`- [${ s.id }] ${ s.priority } ${ s.status } ${ s.title }`);
          }
          if (comments.length) {
            parts.push('', `${ comments.length } comment(s):`);
            for (const c of comments) {
              parts.push(`- [${ c.id }] ${ c.author } @ ${ c.created_at }`);
              parts.push(`  ${ c.body.replace(/\n/g, '\n  ') }`);
            }
          }
          parts.push(...await knowledgeSummary('task', t.id, includeKnowledge));
          return { successBoolean: true, responseString: parts.join('\n') };
        }
      }

      return { successBoolean: false, responseString: `No project item found with id: ${ id }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Get project item failed: ${ err?.message }` };
    }
  }
}
