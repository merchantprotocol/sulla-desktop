import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, fromOp, resolveRecordTypeId } from './_shared';

export class CrmUpdateFieldWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      let fieldId: string | undefined = input?.field_id;

      if (!fieldId) {
        const typeKeyOrId = input?.record_type ?? input?.record_type_id;
        const fieldKey = input?.field_key ?? input?.key;
        if (!typeKeyOrId || !fieldKey) {
          return fail('crm/update_field needs { field_id } OR { record_type, field_key }.');
        }
        const recordTypeId = await resolveRecordTypeId(String(typeKeyOrId));
        const found = await CrmSchemaService.getFieldByKey(recordTypeId, String(fieldKey));
        if (!found) return fail(`Field "${ fieldKey }" not found on record type "${ typeKeyOrId }".`);
        fieldId = found.id;
      }

      const updates: Record<string, unknown> = {};
      if (input?.label !== undefined) updates.label = String(input.label);
      if (input?.config !== undefined && typeof input.config === 'object') updates.config = input.config;
      if (input?.is_required !== undefined) updates.is_required = Boolean(input.is_required);
      if (input?.is_unique !== undefined) updates.is_unique = Boolean(input.is_unique);
      if (input?.is_title !== undefined) updates.is_title = Boolean(input.is_title);
      if (input?.position !== undefined && Number.isInteger(Number(input.position))) updates.position = Number(input.position);

      if (!Object.keys(updates).length) return fail('No updatable properties provided.');

      const result = await CrmSchemaService.updateField(fieldId, updates as any);
      return fromOp(result, `Field ${ fieldId } updated.`);
    } catch (err) {
      return fail(`crm/update_field failed: ${ (err as Error).message }`);
    }
  }
}
