import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import type { ViewKind } from '../../services/CrmSchemaService';
import { fromOp, fail, resolveRecordTypeId } from './_shared';

/**
 * Create a saved view for a record type — table | kanban | calendar | list |
 * gallery. `config` carries view-specific options (groupBy, fields, etc.).
 */
export class CrmCreateViewWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id ?? input?.recordTypeId;
    if (!keyOrId || !input?.name || !input?.kind) {
      return fail('crm/create_view needs { record_type, name, kind }.');
    }
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const r = await CrmSchemaService.createView(recordTypeId, {
        name:   String(input.name),
        kind:   String(input.kind) as ViewKind,
        config: input.config,
      });
      return fromOp(r, `Created ${ input.kind } view "${ input.name }"`);
    } catch (err) {
      return fail(`crm/create_view failed: ${ (err as Error).message }`);
    }
  }
}
