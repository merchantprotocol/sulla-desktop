import { RulesModel } from '../../database/models/RulesModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Archive Rule Tool
 *
 * Soft-deletes (archived = true) a user-created rule by its id. The record
 * is never hard-deleted, so the history is always recoverable. To simply
 * pause a rule without retiring it, update it via add_rule with enabled:false
 * instead.
 */
export class ArchiveRuleWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      return { successBoolean: false, responseString: 'The id of the rule to archive is required.' };
    }

    try {
      await RulesModel.ensureTable();
      const ok = await RulesModel.archive(id);
      if (!ok) {
        return { successBoolean: false, responseString: `No rule found with id: ${ id }` };
      }
      return { successBoolean: true, responseString: `Rule archived (soft-deleted): ${ id }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to archive rule: ${ err?.message }` };
    }
  }
}
