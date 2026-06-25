import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail } from './_shared';

/**
 * Patch field values on an existing record. `values` is a partial map keyed
 * by field key; only the provided fields change. Title/search are recomputed.
 */
export class CrmUpdateRecordWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const recordId = input?.record_id ?? input?.recordId ?? input?.id;
    if (!recordId || !input?.values || typeof input.values !== 'object') {
      return fail('crm/update_record needs { record_id, values:{...} }.');
    }
    try {
      const r = await CrmSchemaService.updateRecord(String(recordId), input.values);
      return fromOp(r, `Updated record ${ recordId }`);
    } catch (err) {
      return fail(`crm/update_record failed: ${ (err as Error).message }`);
    }
  }
}
