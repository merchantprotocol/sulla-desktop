import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';

export class CrmListWidgetsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const dashboardId = input?.dashboard_id ?? input?.id;
    if (!dashboardId) return fail('crm/list_widgets needs { dashboard_id }.');
    try {
      const widgets = await CrmSchemaService.listWidgets(String(dashboardId));
      if (!widgets.length) {
        return { successBoolean: true, responseString: `No widgets in dashboard ${ dashboardId }. Use crm/create_widget to add one.` };
      }
      const lines = widgets.map((w: any) =>
        `  • ${ w.name } (kind:${ w.kind }, type:${ w.record_type_key ?? '—' }, id:${ w.id })`,
      );
      return {
        successBoolean: true,
        responseString: `${ widgets.length } widget(s) in dashboard ${ dashboardId }:\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return fail(`crm/list_widgets failed: ${ (err as Error).message }`);
    }
  }
}
