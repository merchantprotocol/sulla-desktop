import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import type { WidgetKind } from '../../services/CrmSchemaService';
import { fromOp, fail, resolveRecordTypeId } from './_shared';

/**
 * Add a widget to a dashboard — stat | line | bar | funnel | list | table —
 * driven by a record type. `config` carries the metric/grouping options.
 */
export class CrmCreateWidgetWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const dashboardId = input?.dashboard_id ?? input?.dashboardId;
    const keyOrId = input?.record_type ?? input?.record_type_id ?? input?.recordTypeId;
    if (!dashboardId || !keyOrId || !input?.name || !input?.kind) {
      return fail('crm/create_widget needs { dashboard_id, record_type, name, kind }.');
    }
    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const r = await CrmSchemaService.createWidget(String(dashboardId), {
        recordTypeId,
        name:   String(input.name),
        kind:   String(input.kind) as WidgetKind,
        config: input.config,
      });
      return fromOp(r, `Created ${ input.kind } widget "${ input.name }"`);
    } catch (err) {
      return fail(`crm/create_widget failed: ${ (err as Error).message }`);
    }
  }
}
