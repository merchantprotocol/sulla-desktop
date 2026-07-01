import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, fromOp, resolveRecordTypeId } from './_shared';

export class CrmUpdateRecordTypeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.id ?? input?.record_type_id;
    if (!keyOrId) return fail('crm/update_record_type needs { record_type }.');
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));

      const updates: Record<string, unknown> = {};
      if (input?.label !== undefined) updates.label = String(input.label);
      if (input?.label_plural !== undefined) updates.label_plural = String(input.label_plural);
      if (input?.icon !== undefined) updates.icon = String(input.icon);
      if (input?.color !== undefined) updates.color = String(input.color);
      if (input?.description !== undefined) updates.description = String(input.description);
      if (input?.position !== undefined && Number.isInteger(Number(input.position))) updates.position = Number(input.position);

      if (!Object.keys(updates).length) return fail('No updatable properties provided (label, label_plural, icon, color, description, position).');

      const result = await CrmSchemaService.updateRecordType(recordTypeId, updates as any);
      return fromOp(result, `Record type ${ keyOrId } updated.`);
    } catch (err) {
      return fail(`crm/update_record_type failed: ${ (err as Error).message }`);
    }
  }
}
