import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, resolveRecordTypeId } from './_shared';

export class CrmListViewsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id;
    if (!keyOrId) return fail('crm/list_views needs { record_type }.');
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const views = await CrmSchemaService.listViews(recordTypeId);
      if (!views.length) {
        return { successBoolean: true, responseString: `No views for ${ keyOrId }. Use crm/create_view to add one.` };
      }
      const lines = views.map((v: any) => `  • ${ v.name } (kind:${ v.kind }, id:${ v.id })`);
      return {
        successBoolean: true,
        responseString: `${ views.length } view(s) for ${ keyOrId }:\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return fail(`crm/list_views failed: ${ (err as Error).message }`);
    }
  }
}
