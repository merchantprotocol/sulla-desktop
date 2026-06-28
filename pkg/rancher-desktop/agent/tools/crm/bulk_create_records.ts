import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, resolveRecordTypeId } from './_shared';

export class CrmBulkCreateRecordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id;
    if (!keyOrId) return fail('crm/bulk_create_records needs { record_type }.');
    if (!Array.isArray(input?.items) || !input.items.length) {
      return fail('crm/bulk_create_records needs { items: [...] } — a non-empty array of field-value maps.');
    }
    if (input.items.length > 200) {
      return fail('crm/bulk_create_records: items array exceeds max of 200 per call.');
    }
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const { created, errors } = await CrmSchemaService.bulkCreateRecords(
        recordTypeId,
        input.items,
        undefined,
        input?.created_by,
      );
      const parts: string[] = [`Created ${ created }/${ input.items.length } ${ keyOrId } record(s).`];
      if (errors.length) {
        parts.push(`${ errors.length } error(s):`);
        errors.forEach(e => parts.push(`  index ${ e.index }: ${ e.error }`));
      }
      return { successBoolean: errors.length === 0, responseString: parts.join('\n') };
    } catch (err) {
      return fail(`crm/bulk_create_records failed: ${ (err as Error).message }`);
    }
  }
}
