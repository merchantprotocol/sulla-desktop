import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, fromOp } from './_shared';

export class CrmArchiveDashboardWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const dashboardId = input?.dashboard_id ?? input?.id;
    if (!dashboardId) return fail('crm/archive_dashboard needs { dashboard_id }.');
    if (!input?.confirm) return fail('crm/archive_dashboard requires { confirm: true }. This soft-deletes the dashboard and all its widgets.');
    try {
      const result = await CrmSchemaService.archiveDashboard(String(dashboardId));
      return fromOp(result, `Dashboard ${ dashboardId } archived.`);
    } catch (err) {
      return fail(`crm/archive_dashboard failed: ${ (err as Error).message }`);
    }
  }
}
