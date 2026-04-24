import { BaseTool, ToolResponse } from '../base';
import { getMobileApiClient } from './MobileApiClient';

/**
 * Fetch full details for one call — includes transcript, AI summary, extracted
 * lead metadata, and caller info.
 */
export class MobileGetCallWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      return { successBoolean: false, responseString: 'Missing required field: id (call id).' };
    }

    try {
      const call = await getMobileApiClient().request<any>('GET', `/calls/${ encodeURIComponent(id) }`);
      const parts: string[] = [];
      parts.push(`Call ${ id } — ${ call.status || 'unknown' }`);
      if (call.caller_name || call.caller_number) {
        parts.push(`Caller: ${ call.caller_name || '(no name)' } — ${ call.caller_number || '(no number)' }`);
      }
      if (call.started_at) parts.push(`Started: ${ call.started_at }`);
      if (call.duration_seconds) parts.push(`Duration: ${ call.duration_seconds }s`);
      if (call.ai_summary) parts.push(`\nSummary:\n${ call.ai_summary }`);
      if (call.lead) {
        parts.push(`\nExtracted lead:\n${ JSON.stringify(call.lead, null, 2) }`);
      }
      if (call.transcript) {
        const t = typeof call.transcript === 'string' ? call.transcript : JSON.stringify(call.transcript, null, 2);
        parts.push(`\nTranscript:\n${ t.slice(0, 4000) }${ t.length > 4000 ? '\n… (truncated)' : '' }`);
      }
      return { successBoolean: true, responseString: parts.join('\n') };
    } catch (err) {
      return { successBoolean: false, responseString: `mobile/get_call failed: ${ (err as Error).message }` };
    }
  }
}
