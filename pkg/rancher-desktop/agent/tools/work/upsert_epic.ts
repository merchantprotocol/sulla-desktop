import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Create or update an epic under a work project.
 */
export class UpsertEpicWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const projectId = typeof input.project_id === 'string' ? input.project_id.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!id && !title) {
      return { successBoolean: false, responseString: 'title is required to create an epic (or pass id to update).' };
    }
    if (!id && !projectId) {
      return { successBoolean: false, responseString: 'project_id is required to create an epic.' };
    }

    try {
      await WorkItemsModel.ensureTables();

      if (id) {
        const updated = await WorkItemsModel.updateEpic(id, {
          project_id:  projectId || undefined,
          slug:        slug || undefined,
          title:       title || undefined,
          description: input.description,
          status:      input.status,
          priority:    input.priority,
          position:    input.position,
          due_at:      input.due_at === '' ? null : input.due_at,
          source:      input.source,
        });
        if (!updated) {
          return { successBoolean: false, responseString: `No epic found with id: ${ id }` };
        }
        return {
          successBoolean: true,
          responseString: `Epic updated: "${ updated.title }" (id: ${ updated.id }, project: ${ updated.project_id }, status: ${ updated.status }, priority: ${ updated.priority })`,
        };
      }

      const record = await WorkItemsModel.upsertEpic({
        project_id:  projectId,
        slug:        slug || undefined,
        title,
        description: input.description,
        status:      input.status,
        priority:    input.priority,
        position:    input.position,
        due_at:      input.due_at === '' ? null : input.due_at,
        source:      input.source || 'agent',
      });
      return {
        successBoolean: true,
        responseString: `Epic saved: "${ record.title }" (id: ${ record.id }, project: ${ record.project_id }, status: ${ record.status }, priority: ${ record.priority })`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to save epic: ${ err?.message }` };
    }
  }
}
