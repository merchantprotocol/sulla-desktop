import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail } from './_shared';

/** Archive (soft-delete) a single record. Reversible via the audit/undo log. */
export class CrmArchiveRecordWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const recordId = input?.record_id ?? input?.recordId ?? input?.id;
    if (!recordId) return fail('crm/archive_record needs { record_id }.');
    try {
      const r = await CrmSchemaService.archiveRecord(String(recordId));
      return fromOp(r, `Archived record ${ recordId }`);
    } catch (err) {
      return fail(`crm/archive_record failed: ${ (err as Error).message }`);
    }
  }
}
