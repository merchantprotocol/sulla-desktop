import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';

export class CrmListDashboardsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(): Promise<ToolResponse> {
    try {
      const dashboards = await CrmSchemaService.listDashboards();
      if (!dashboards.length) {
        return { successBoolean: true, responseString: 'No dashboards yet. Use crm/create_dashboard to add one.' };
      }
      const lines = dashboards.map((d: any) =>
        `  • ${ d.name } (key:${ d.key }, id:${ d.id }, widgets:${ d.widget_count })`,
      );
      return {
        successBoolean: true,
        responseString: `${ dashboards.length } dashboard(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return fail(`crm/list_dashboards failed: ${ (err as Error).message }`);
    }
  }
}
