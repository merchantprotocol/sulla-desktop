import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

function slugify(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

/**
 * Create a NEW epic under a project. Always inserts (unique slug within the
 * project) — use update_epic to change an existing one.
 */
export class CreateEpicWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const projectId = typeof input.project_id === 'string' ? input.project_id.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!projectId) return { successBoolean: false, responseString: 'project_id is required to create an epic.' };
    if (!title) return { successBoolean: false, responseString: 'title is required to create an epic.' };

    try {
      await WorkItemsModel.ensureTables();
      const existing = await WorkItemsModel.listEpics({ projectId, includeDone: true, limit: 1000 });
      const taken = new Set(existing.map(e => e.slug).filter(Boolean) as string[]);
      const base = slugify(input.slug || title);
      let slug = base;
      let n = 2;
      while (taken.has(slug)) slug = `${ base }-${ n++ }`;

      const record = await WorkItemsModel.upsertEpic({
        project_id:  projectId,
        slug,
        title,
        description: input.description,
        status:      input.status,
        priority:    input.priority,
        position:    typeof input.position === 'number' ? input.position : undefined,
        due_at:      input.due_at === '' ? null : input.due_at,
        source:      input.source || 'agent',
      });

      return {
        successBoolean: true,
        responseString: `Epic created: "${ record.title }" (id: ${ record.id }, project: ${ record.project_id }, status: ${ record.status }, priority: ${ record.priority })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to create epic: ${ err?.message }` };
    }
  }
}
