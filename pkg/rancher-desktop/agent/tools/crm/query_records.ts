import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, resolveRecordTypeId } from './_shared';

/**
 * Query records of a given type, newest first, with their field values
 * hydrated. Accepts type key or id; `limit` defaults to 100.
 */
export class CrmQueryRecordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id ?? input?.recordTypeId;
    if (!keyOrId) return fail('crm/query_records needs { record_type }.');
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(500, input.limit) : 100;
      const filter = (input.filter && typeof input.filter === 'object') ? input.filter : undefined;
      const sort = Array.isArray(input.sort) ? input.sort : undefined;
      const rows = await CrmSchemaService.queryRecords(recordTypeId, { filter, sort, limit });
      if (!rows.length) {
        return { successBoolean: true, responseString: `No ${ keyOrId } records found.` };
      }
      return {
        successBoolean: true,
        responseString: `${ rows.length } ${ keyOrId } record(s):\n${ JSON.stringify(rows, null, 2) }`,
      };
    } catch (err) {
      return fail(`crm/query_records failed: ${ (err as Error).message }`);
    }
  }
}
