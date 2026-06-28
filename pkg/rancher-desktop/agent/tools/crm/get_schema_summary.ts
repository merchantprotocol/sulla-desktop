import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';

export class CrmGetSchemaSummaryWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(): Promise<ToolResponse> {
    try {
      const { types, dashboards } = await CrmSchemaService.getSchemaSummary();
      if (!types.length && !dashboards.length) {
        return {
          successBoolean: true,
          responseString: 'CRM is empty. Use crm/create_record_type to get started.',
        };
      }

      const typeLines = types.map((t: any) =>
        `  • ${ t.label } (key:${ t.key }, id:${ t.id }) — ${ t.field_count } field(s), ${ t.relationship_count } relationship(s)`,
      );
      const dashLines = dashboards.map((d: any) =>
        `  • ${ d.name } (key:${ d.key }, id:${ d.id }, ${ d.widget_count } widget(s))`,
      );

      const parts: string[] = [];
      if (types.length) {
        parts.push(`${ types.length } record type(s):`);
        parts.push(...typeLines);
      }
      if (dashboards.length) {
        parts.push(`\n${ dashboards.length } dashboard(s):`);
        parts.push(...dashLines);
      }

      return { successBoolean: true, responseString: parts.join('\n') };
    } catch (err) {
      return fail(`crm/get_schema_summary failed: ${ (err as Error).message }`);
    }
  }
}
