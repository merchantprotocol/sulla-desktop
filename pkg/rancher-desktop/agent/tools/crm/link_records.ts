import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail } from './_shared';

/**
 * Link two records via a defined relationship — e.g. attach a Person to a
 * Company. Needs the relationship id plus both record ids.
 */
export class CrmLinkRecordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const rel = input?.relationship_id ?? input?.relationshipId;
    const from = input?.from_record_id ?? input?.fromRecordId;
    const to = input?.to_record_id ?? input?.toRecordId;
    if (!rel || !from || !to) {
      return fail('crm/link_records needs { relationship_id, from_record_id, to_record_id }.');
    }
    try {
      const r = await CrmSchemaService.link(String(rel), String(from), String(to));
      return fromOp(r, `Linked ${ from } → ${ to }`);
    } catch (err) {
      return fail(`crm/link_records failed: ${ (err as Error).message }`);
    }
  }
}
