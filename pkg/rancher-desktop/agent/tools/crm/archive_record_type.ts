import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail } from './_shared';

/**
 * Archive (soft-delete) a record type and hide its records. Destructive —
 * requires confirm:true. Reversible via the audit/undo log.
 */
export class CrmArchiveRecordTypeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!input?.id) return fail('crm/archive_record_type needs { id, confirm:true }.');
    if (input.confirm !== true) {
      return fail('Refusing to archive without confirm:true — this hides the type and all its records.');
    }
    try {
      const r = await CrmSchemaService.archiveRecordType(String(input.id), { confirm: true });
      return fromOp(r, `Archived record type ${ input.id }`);
    } catch (err) {
      return fail(`crm/archive_record_type failed: ${ (err as Error).message }`);
    }
  }
}
