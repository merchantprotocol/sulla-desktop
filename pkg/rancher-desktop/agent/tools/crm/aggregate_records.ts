import { BaseTool, ToolResponse } from '../base';
import { CrmSchemaService } from '../../services/CrmSchemaService';
import { fail, resolveRecordTypeId } from './_shared';

const VALID_METRICS = new Set(['count', 'sum', 'avg', 'min', 'max']);

export class CrmAggregateRecordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const keyOrId = input?.record_type ?? input?.record_type_id;
    if (!keyOrId) return fail('crm/aggregate_records needs { record_type }.');

    const metric: string = input?.metric ?? 'count';
    if (!VALID_METRICS.has(metric)) return fail(`metric must be one of: ${ [...VALID_METRICS].join('|') }.`);
    if (metric !== 'count' && !input?.field) {
      return fail(`metric "${ metric }" requires a { field } key to aggregate on.`);
    }

    try {
      const recordTypeId = await resolveRecordTypeId(String(keyOrId));
      const rows = await CrmSchemaService.aggregateRecords(recordTypeId, {
        metric: metric as any,
        field: input?.field,
        groupBy: input?.group_by ?? input?.groupBy,
        filter: input?.filter,
        limit: typeof input?.limit === 'number' ? Math.min(500, input.limit) : 100,
      });

      if (!rows.length) {
        return { successBoolean: true, responseString: 'No matching records.' };
      }

      const hasGroup = 'group_value' in rows[0];
      if (hasGroup) {
        const lines = rows.map((r: any) =>
          `  ${ r.group_value ?? '(null)' }: count=${ r.count }, ${ metric }=${ r.metric ?? 'null' }`,
        );
        return {
          successBoolean: true,
          responseString: `${ rows.length } group(s):\n${ lines.join('\n') }`,
        };
      }

      const r = rows[0];
      return {
        successBoolean: true,
        responseString: metric === 'count'
          ? `count: ${ r.count }`
          : `count: ${ r.count }, ${ metric }: ${ r.metric ?? 'null' }`,
      };
    } catch (err) {
      return fail(`crm/aggregate_records failed: ${ (err as Error).message }`);
    }
  }
}
