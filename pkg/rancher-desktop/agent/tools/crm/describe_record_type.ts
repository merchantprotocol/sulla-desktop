import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, resolveRecordTypeId } from './_shared';

export class CrmDescribeRecordTypeWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id ?? input?.key ?? input?.id;
    if (!keyOrId) return fail('crm/describe_record_type needs { record_type }.');
    try {
      const desc = await CrmSchemaService.describeRecordType(String(keyOrId));
      if (!desc) return fail(`Record type "${ keyOrId }" not found.`);

      const fields = desc.fields.map((f: any) =>
        `  • ${ f.key } (${ f.data_type })${ f.is_title ? ' [title]' : '' }${ f.is_required ? ' [required]' : '' }${ f.is_system ? ' [system]' : '' }`,
      ).join('\n');

      const rels = desc.relationships.length
        ? desc.relationships.map((r: any) =>
          `  • ${ r.key } (${ r.cardinality }): ${ r.from_type_key } → ${ r.to_type_key }`,
        ).join('\n')
        : '  (none)';

      const lines = [
        `Type: ${ desc.label } (key:${ desc.key }, id:${ desc.id })`,
        desc.label_plural ? `Plural: ${ desc.label_plural }` : null,
        desc.description ? `Description: ${ desc.description }` : null,
        `\nFields (${ desc.fields.length }):`,
        fields || '  (none)',
        `\nRelationships (${ desc.relationships.length }):`,
        rels,
      ].filter(Boolean);

      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err) {
      return fail(`crm/describe_record_type failed: ${ (err as Error).message }`);
    }
  }
}
