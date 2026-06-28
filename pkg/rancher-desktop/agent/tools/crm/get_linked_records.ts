import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';

export class CrmGetLinkedRecordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const recordId = input?.record_id ?? input?.id;
    if (!recordId) return fail('crm/get_linked_records needs { record_id }.');
    try {
      const direction = input?.direction ?? 'both';
      if (!['from', 'to', 'both'].includes(direction)) {
        return fail('direction must be "from", "to", or "both".');
      }
      const limit = typeof input?.limit === 'number' ? Math.min(200, input.limit) : 50;
      const rows = await CrmSchemaService.getLinkedRecords(String(recordId), {
        relationshipId: input?.relationship_id,
        direction,
        limit,
      });
      if (!rows.length) {
        return { successBoolean: true, responseString: `No linked records found for ${ recordId }.` };
      }
      const lines = rows.map((r: any) =>
        `  [${ r.direction }] ${ r.record_type_label } — ${ r.title ?? r.id } (id:${ r.id }, rel:${ r.relationship_key })`,
      );
      return {
        successBoolean: true,
        responseString: `${ rows.length } linked record(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return fail(`crm/get_linked_records failed: ${ (err as Error).message }`);
    }
  }
}
