import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail, toFieldInput } from './_shared';

/**
 * Create a brand-new record type (a "table") in the dynamic CRM — e.g.
 * "Property", "Vehicle", "Permit". Optionally seed its fields inline.
 */
export class CrmCreateRecordTypeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!input?.key || !input?.label) {
      return fail('crm/create_record_type needs at least { key, label }.');
    }
    try {
      const fields = Array.isArray(input.fields) ? input.fields.map(toFieldInput) : undefined;
      const r = await CrmSchemaService.createRecordType({
        key:         String(input.key),
        label:       String(input.label),
        labelPlural: String(input.label_plural ?? input.labelPlural ?? `${ input.label }s`),
        icon:        input.icon,
        color:       input.color,
        description: input.description,
        fields,
      });
      return fromOp(r, `Created record type "${ input.label }"`);
    } catch (err) {
      return fail(`crm/create_record_type failed: ${ (err as Error).message }`);
    }
  }
}
