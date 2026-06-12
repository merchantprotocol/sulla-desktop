import { ObservationsModel } from '../../database/models/ObservationsModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * List Observations Tool
 *
 * Returns active observations from the `observations` table, sorted by
 * priority (critical/high first) then recency.  Optionally filter by
 * priority or include archived rows.
 */
export class ListObservationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { priority, limit = 50, include_archived = false } = input;

    try {
      let rows;

      if (include_archived) {
        // When include_archived is requested use the raw search with wildcard
        // to get all rows (both active and archived).
        rows = await ObservationsModel.search('%', Number(limit) || 50, true);
        if (priority) {
          rows = rows.filter(r => r.priority === priority);
        }
      } else {
        rows = await ObservationsModel.listActive(
          priority || undefined,
          Number(limit) || 50,
        );
      }

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: 'No observations found.',
        };
      }

      const lines = rows.map(r =>
        `[id:${ r.id }] ${ r.priority } ${ r.created_at } — ${ r.content }${ r.archived ? ' (archived)' : '' }`,
      );

      return {
        successBoolean: true,
        responseString: `${ rows.length } observation(s):\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `List failed: ${ err?.message }`,
      };
    }
  }
}
