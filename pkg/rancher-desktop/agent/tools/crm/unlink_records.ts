import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail } from './_shared';

/** Remove a relationship link between two records. */
export class CrmUnlinkRecordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const rel = input?.relationship_id ?? input?.relationshipId;
    const from = input?.from_record_id ?? input?.fromRecordId;
    const to = input?.to_record_id ?? input?.toRecordId;
    if (!rel || !from || !to) {
      return fail('crm/unlink_records needs { relationship_id, from_record_id, to_record_id }.');
    }
    try {
      const r = await CrmSchemaService.unlink(String(rel), String(from), String(to));
      return fromOp(r, `Unlinked ${ from } ⇎ ${ to }`);
    } catch (err) {
      return fail(`crm/unlink_records failed: ${ (err as Error).message }`);
    }
  }
}
