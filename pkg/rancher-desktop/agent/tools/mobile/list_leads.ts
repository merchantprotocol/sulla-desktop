import { BaseTool, ToolResponse } from '../base';
import { getMobileApiClient } from './MobileApiClient';

/**
 * List leads extracted from recent calls — the same rows that appear in
 * the mobile app's Inbox tab.
 */
export class MobileListLeadsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(100, input.limit) : 20;
    const qualifiedOnly = input.qualified_only === true;
    const urgency = typeof input.urgency === 'string' ? input.urgency.trim() : '';

    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (qualifiedOnly) qs.set('qualified', 'true');
    if (urgency) qs.set('urgency', urgency);

    try {
      const result = await getMobileApiClient().request<{ leads?: any[] }>('GET', `/leads?${ qs.toString() }`);
      const leads = result.leads ?? [];
      if (leads.length === 0) {
        return { successBoolean: true, responseString: 'No leads matched the filter.' };
      }
      const lines = leads.map((l: any) => {
        const who = l.contact_name || l.phone || 'unknown';
        const urg = l.urgency ? `[${ l.urgency }]` : '';
        const qual = l.qualified ? '★' : ' ';
        const val = l.estimated_value ? ` ~$${ l.estimated_value }` : '';
        const intent = l.intent ? ` — ${ String(l.intent).slice(0, 80) }` : '';
        return `  ${ qual } ${ urg } ${ who }${ val }${ intent } (id:${ l.id })`;
      });
      return {
        successBoolean: true,
        responseString: `${ leads.length } lead(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `mobile/list_leads failed: ${ (err as Error).message }` };
    }
  }
}
