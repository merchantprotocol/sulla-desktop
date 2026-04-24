import { BaseTool, ToolResponse } from '../base';
import { getMobileApiClient } from './MobileApiClient';

/** List SMS / voicemail transcripts shown in the mobile Messages tab. */
export class MobileListMessagesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(100, input.limit) : 20;
    const unreadOnly = input.unread_only === true;

    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (unreadOnly) qs.set('unread', 'true');

    try {
      const result = await getMobileApiClient().request<{ messages?: any[] }>('GET', `/messages?${ qs.toString() }`);
      const msgs = result.messages ?? [];
      if (msgs.length === 0) {
        return { successBoolean: true, responseString: 'No messages matched the filter.' };
      }
      const lines = msgs.map((m: any) => {
        const from = m.from_name || m.from || '(unknown)';
        const tag = m.kind === 'voicemail' ? '[VM]' : '[SMS]';
        const unread = m.unread ? '●' : '○';
        const body = (m.body || m.transcript || '').replace(/\s+/g, ' ').slice(0, 180);
        return `  ${ unread } ${ tag } ${ m.received_at || '?' } — ${ from }: ${ body }`;
      });
      return {
        successBoolean: true,
        responseString: `${ msgs.length } message(s):\n${ lines.join('\n') }`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `mobile/list_messages failed: ${ (err as Error).message }` };
    }
  }
}
