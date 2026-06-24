import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail, resolveRecordTypeId } from './_shared';

/**
 * Create a record (a row of data) of a given type. `values` is keyed by
 * field key — e.g. { name: "Acme", phone: "555-0100" }. Accepts type key or id.
 */
export class CrmCreateRecordWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id ?? input?.recordTypeId;
    if (!keyOrId || !input?.values || typeof input.values !== 'object') {
      return fail('crm/create_record needs { record_type, values:{...} }.');
    }
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const r = await CrmSchemaService.createRecord(recordTypeId, input.values, undefined, input.created_by);
      return fromOp(r, `Created ${ keyOrId } record`);
    } catch (err) {
      return fail(`crm/create_record failed: ${ (err as Error).message }`);
    }
  }
}
