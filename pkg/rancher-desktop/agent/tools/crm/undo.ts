import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail } from './_shared';

/**
 * Revert a previous CRM mutation by its undo token. Every create/update/
 * archive/link op returns an `[undo:...]` token; pass it here to roll the
 * change back (create→archive, archive→un-archive, update→restore prior
 * values, link→unlink). Idempotent — a token can only be undone once.
 */
export class CrmUndoWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const token = input?.undo_token ?? input?.undoToken;
    if (!token) return fail('crm/undo needs { undo_token } (from an earlier op\'s [undo:...] tag).');
    try {
      const r = await CrmSchemaService.undo(String(token));
      return fromOp(r, 'Reverted');
    } catch (err) {
      return fail(`crm/undo failed: ${ (err as Error).message }`);
    }
  }
}
