import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

function slugify(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

/**
 * Create a NEW work project. Always inserts (resolves a unique slug first) —
 * use update_project to change an existing one.
 */
export class CreateProjectWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) return { successBoolean: false, responseString: 'title is required to create a project.' };

    try {
      await WorkItemsModel.ensureTables();
      const base = slugify(input.slug || title);
      let slug = base;
      let n = 2;
      while (await WorkItemsModel.getProjectBySlug(slug)) slug = `${ base }-${ n++ }`;

      const record = await WorkItemsModel.upsertProject({
        slug,
        title,
        description:    input.description,
        outcome_metric: input.outcome_metric,
        status:         input.status,
        priority:       input.priority,
        owner:          input.owner,
        due_at:         input.due_at === '' ? null : input.due_at,
        github_repo:    input.github_repo,
        source:         input.source || 'agent',
      });

      return {
        successBoolean: true,
        responseString: `Project created: "${ record.title }" (id: ${ record.id }, slug: ${ record.slug }, status: ${ record.status }, priority: ${ record.priority })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to create project: ${ err?.message }` };
    }
  }
}
