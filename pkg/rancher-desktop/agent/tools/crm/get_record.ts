import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';

export class CrmGetRecordWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const recordId = input?.record_id ?? input?.id;
    if (!recordId) return fail('crm/get_record needs { record_id }.');
    try {
      const record = await CrmSchemaService.getRecord(String(recordId));
      if (!record) return { successBoolean: true, responseString: `Record ${ recordId } not found.` };
      return {
        successBoolean: true,
        responseString: `Record:\n${ JSON.stringify(record, null, 2) }`,
      };
    } catch (err) {
      return fail(`crm/get_record failed: ${ (err as Error).message }`);
    }
  }
}
