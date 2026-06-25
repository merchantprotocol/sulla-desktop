import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail, toFieldInput, resolveRecordTypeId } from './_shared';

/**
 * Add a custom field (column) to an existing record type — e.g. add
 * "birthday" or "anniversary" to a Contact type. Accepts the type key or id.
 */
export class CrmAddFieldWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id ?? input?.recordTypeId;
    if (!keyOrId || !input?.key) {
      return fail('crm/add_field needs { record_type, key, data_type }.');
    }
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const r = await CrmSchemaService.addField(recordTypeId, toFieldInput(input));
      return fromOp(r, `Added field "${ input.key }" to ${ keyOrId }`);
    } catch (err) {
      return fail(`crm/add_field failed: ${ (err as Error).message }`);
    }
  }
}
