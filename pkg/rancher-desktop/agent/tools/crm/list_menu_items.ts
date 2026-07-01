import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail } from './_shared';

export class CrmListMenuItemsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(): Promise<ToolResponse> {
    try {
      const items = await CrmSchemaService.listMenuItems();
      if (!items.length) {
        return { successBoolean: true, responseString: 'No nav menu items found.' };
      }
      const lines = items.map((m: any) => {
        const target = m.target_type === 'record_type'
          ? `type:${ m.target_id ?? '—' }`
          : m.target_type === 'dashboard'
            ? `dashboard:${ m.target_id ?? '—' }`
            : `url:${ m.target_url ?? '—' }`;
        const flags = [m.is_system ? '[system]' : null, m.auto_created ? '[auto]' : null].filter(Boolean).join(' ');
        return `  ${ m.position }. ${ m.label } (${ target }, id:${ m.id }) ${ flags }`;
      });
      return {
        successBoolean: true,
        responseString: `${ items.length } nav item(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return fail(`crm/list_menu_items failed: ${ (err as Error).message }`);
    }
  }
}
