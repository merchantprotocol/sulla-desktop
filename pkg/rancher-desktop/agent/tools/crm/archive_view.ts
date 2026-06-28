import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, fromOp } from './_shared';

export class CrmArchiveViewWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const viewId = input?.view_id ?? input?.id;
    if (!viewId) return fail('crm/archive_view needs { view_id }.');
    if (!input?.confirm) return fail('crm/archive_view requires { confirm: true }. This soft-deletes the view.');
    try {
      const result = await CrmSchemaService.archiveView(String(viewId));
      return fromOp(result, `View ${ viewId } archived.`);
    } catch (err) {
      return fail(`crm/archive_view failed: ${ (err as Error).message }`);
    }
  }
}
