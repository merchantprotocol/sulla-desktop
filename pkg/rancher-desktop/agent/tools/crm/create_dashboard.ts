import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fromOp, fail } from './_shared';

/**
 * Create a dashboard (a named container for widgets). Returns the dashboard
 * id to pass to crm/create_widget.
 */
export class CrmCreateDashboardWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!input?.key || !input?.name) {
      return fail('crm/create_dashboard needs { key, name }.');
    }
    try {
      const r = await CrmSchemaService.createDashboard({
        key:    String(input.key),
        name:   String(input.name),
        icon:   input.icon,
        layout: input.layout,
      });
      return fromOp(r, `Created dashboard "${ input.name }"`);
    } catch (err) {
      return fail(`crm/create_dashboard failed: ${ (err as Error).message }`);
    }
  }
}
