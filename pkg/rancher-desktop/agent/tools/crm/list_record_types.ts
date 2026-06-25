import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';

/**
 * List every record type in the dynamic CRM, with keys + ids so the AI can
 * target follow-up calls (add_field, create_record, query_records, etc.).
 */
export class CrmListRecordTypesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(): Promise<ToolResponse> {
    try {
      const types = await CrmSchemaService.listRecordTypes();
      if (!types.length) {
        return { successBoolean: true, responseString: 'No record types defined yet. Use crm/create_record_type to add one.' };
      }
      const lines = types.map((t: any) => `  • ${ t.label } (key:${ t.key }, id:${ t.id })`);
      return { successBoolean: true, responseString: `${ types.length } record type(s):\n${ lines.join('\n') }` };
    } catch (err) {
      return fail(`crm/list_record_types failed: ${ (err as Error).message }`);
    }
  }
}
