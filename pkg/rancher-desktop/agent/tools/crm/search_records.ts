import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, resolveRecordTypeId } from './_shared';

export class CrmSearchRecordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id;
    if (!keyOrId) return fail('crm/search_records needs { record_type }.');
    const q = input?.q ?? input?.query;
    if (!q || String(q).trim().length < 2) return fail('crm/search_records needs { q } with at least 2 characters.');
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const limit = typeof input?.limit === 'number' ? Math.min(200, input.limit) : 50;
      const rows = await CrmSchemaService.searchRecords(recordTypeId, String(q), { limit });
      if (!rows.length) {
        return { successBoolean: true, responseString: `No ${ keyOrId } records match "${ q }".` };
      }
      return {
        successBoolean: true,
        responseString: `${ rows.length } ${ keyOrId } record(s) matching "${ q }":\n${ JSON.stringify(rows, null, 2) }`,
      };
    } catch (err) {
      return fail(`crm/search_records failed: ${ (err as Error).message }`);
    }
  }
}
