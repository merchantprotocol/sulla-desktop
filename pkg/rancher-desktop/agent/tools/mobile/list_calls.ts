import { BaseTool, ToolResponse } from '../base';
import { getMobileApiClient } from './MobileApiClient';

/**
 * List recent calls handled by the AI receptionist (Sulla Mobile).
 * Hits `GET /calls?limit=N` on the mobile backend.
 */
export class MobileListCallsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(100, input.limit) : 20;
    const status = typeof input.status === 'string' ? input.status.trim() : '';

    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (status) qs.set('status', status);

    try {
      const result = await getMobileApiClient().request<{ calls?: any[] }>('GET', `/calls?${ qs.toString() }`);
      const calls = result.calls ?? [];
      if (calls.length === 0) {
        return { successBoolean: true, responseString: 'No calls found matching the filter.' };
      }
      const lines = calls.map((c: any) => {
        const who = c.caller_name || c.caller_number || 'unknown';
        const when = c.started_at || c.created_at || '?';
        const dur = c.duration_seconds ? `${ c.duration_seconds }s` : '?';
        const tag = c.status ? `[${ c.status }]` : '';
        return `  ${ tag } ${ when } — ${ who } — ${ dur } — id:${ c.id }`;
      });
      return {
        successBoolean: true,
        responseString: `${ calls.length } call(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `mobile/list_calls failed: ${ (err as Error).message }` };
    }
  }
}
