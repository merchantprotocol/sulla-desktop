import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Create or update a work project (operator agenda, not a filesystem PRD).
 */
export class UpsertProjectWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!id && !title) {
      return { successBoolean: false, responseString: 'title is required to create a project (or pass id to update).' };
    }

    try {
      await WorkItemsModel.ensureTables();

      if (id) {
        const updated = await WorkItemsModel.updateProject(id, {
          slug:        slug || undefined,
          title:       title || undefined,
          description: input.description,
          status:      input.status,
          priority:    input.priority,
          owner:       input.owner,
          due_at:      input.due_at === '' ? null : input.due_at,
          source:      input.source,
        });
        if (!updated) {
          return { successBoolean: false, responseString: `No project found with id: ${ id }` };
        }
        return {
          successBoolean: true,
          responseString: `Project updated: "${ updated.title }" (id: ${ updated.id }, slug: ${ updated.slug }, status: ${ updated.status }, priority: ${ updated.priority })`,
        };
      }

      const record = await WorkItemsModel.upsertProject({
        slug:        slug || undefined,
        title,
        description: input.description,
        status:      input.status,
        priority:    input.priority,
        owner:       input.owner,
        due_at:      input.due_at === '' ? null : input.due_at,
        source:      input.source || 'agent',
      });
      return {
        successBoolean: true,
        responseString: `Project saved: "${ record.title }" (id: ${ record.id }, slug: ${ record.slug }, status: ${ record.status }, priority: ${ record.priority })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to save project: ${ err?.message }` };
    }
  }
}
