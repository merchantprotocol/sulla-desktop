import { IdentityObservationsModel, normalizeIdentityDomain } from '../../database/models/IdentityObservationsModel';
import { formatDateOnly } from '../../utils/formatDateOnly';
import { BaseTool, ToolResponse } from '../base';

/**
 * List Identity Observations Tool
 *
 * Lists active rows for one domain of the `identity_observations` table,
 * most certain first (L3 stated → L2 derived → L1 concluded) then most
 * recent. Optionally filters by level and/or category.
 */
export class ListIdentityObservationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const level = input.level !== undefined ? Number(input.level) : undefined;
    const category = typeof input.category === 'string' && input.category.trim() ? input.category.trim() : undefined;
    const limit = Number(input.limit) || 50;

    try {
      const domain = normalizeIdentityDomain(input.domain);
      const rows = await IdentityObservationsModel.listActive(domain, { level, category, limit });

      if (rows.length === 0) {
        return {
          successBoolean: true,
          responseString: `No active ${ domain } identity observations${ level ? ` at L${ level }` : '' }${ category ? ` in category "${ category }"` : '' }.`,
        };
      }

      const lines = rows.map(r =>
        `[id:${ r.id }] L${ r.level }${ r.category ? `·${ r.category }` : '' } ${ formatDateOnly(r.created_at) } — ${ r.content }${ r.basis ? ` (basis: ${ r.basis })` : '' }`,
      );

      return {
        successBoolean: true,
        responseString: `${ rows.length } active ${ domain } identity observation(s), most certain first:\n${ lines.join('\n') }`,
      };
    } catch (err: any) {
      return {
        successBoolean: false,
        responseString: `Failed to list identity observations: ${ err?.message }`,
      };
    }
  }
}
