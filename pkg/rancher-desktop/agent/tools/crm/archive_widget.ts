import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, fromOp } from './_shared';

export class CrmArchiveWidgetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const widgetId = input?.widget_id ?? input?.id;
    if (!widgetId) return fail('crm/archive_widget needs { widget_id }.');
    if (!input?.confirm) return fail('crm/archive_widget requires { confirm: true }. This soft-deletes the widget.');
    try {
      const result = await CrmSchemaService.archiveWidget(String(widgetId));
      return fromOp(result, `Widget ${ widgetId } archived.`);
    } catch (err) {
      return fail(`crm/archive_widget failed: ${ (err as Error).message }`);
    }
  }
}
