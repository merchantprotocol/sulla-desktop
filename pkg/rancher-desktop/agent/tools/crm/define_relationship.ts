import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import type { Cardinality } from '../../services/CrmSchemaService';
import { fromOp, fail, resolveRecordTypeId } from './_shared';

/**
 * Define a typed relationship between two record types
 * (one_to_one | one_to_many | many_to_many). Accepts type keys or ids.
 */
export class CrmDefineRelationshipWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const from = input?.from_type ?? input?.fromTypeId;
    const to = input?.to_type ?? input?.toTypeId;
    if (!input?.key || !from || !to || !input?.cardinality) {
      return fail('crm/define_relationship needs { key, from_type, to_type, cardinality }.');
    }
    try {
      const r = await CrmSchemaService.defineRelationship({
        key:         String(input.key),
        fromTypeId:  await resolveRecordTypeId(String(from)),
        toTypeId:    await resolveRecordTypeId(String(to)),
        cardinality: String(input.cardinality) as Cardinality,
        fromLabel:   input.from_label ?? input.fromLabel,
        toLabel:     input.to_label ?? input.toLabel,
      });
      return fromOp(r, `Defined relationship "${ input.key }"`);
    } catch (err) {
      return fail(`crm/define_relationship failed: ${ (err as Error).message }`);
    }
  }
}
