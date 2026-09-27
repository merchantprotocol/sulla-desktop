import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient, isAuthError, SIGN_IN_HINT } from './MarketplaceClient';

/** Everything the signed-in user has submitted, with review status and reviewer notes. */
export class MarketplaceListPublishedWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const items = await getMarketplaceClient().mySubmissions();
      if (items.length === 0) {
        return { successBoolean: true, responseString: 'You haven\'t submitted anything to the marketplace yet.' };
      }
      const label: Record<string, string> = { pending: 'pending review', approved: 'live', rejected: 'rejected / withdrawn' };
      const lines = items.map((i) => {
        const bundle = i.bundle_status === 'pending' ? ' (bundle not uploaded)' : '';
        const notes = i.admin_notes ? `\n     reviewer: ${ i.admin_notes.split('\n').slice(-1)[0] }` : '';

        return `  - ${ i.kind }/${ i.slug } v${ i.version } — ${ label[i.status] ?? i.status }${ bundle } · ${ i.download_count ?? 0 } downloads · ${ i.id }${ notes }`;
      });

      return {
        successBoolean: true,
        responseString: `Your marketplace submissions (${ items.length }):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      if (isAuthError(err)) return { successBoolean: false, responseString: `Listing your submissions needs a Sulla Cloud session. ${ SIGN_IN_HINT }` };

      return { successBoolean: false, responseString: `Failed to list your submissions: ${ (err as Error).message }` };
    }
  }
}
