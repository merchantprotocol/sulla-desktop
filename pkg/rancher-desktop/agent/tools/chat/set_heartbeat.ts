import { getChatHeartbeatService } from '../../services/ChatHeartbeatService';
import { BaseTool, ToolResponse } from '../base';

import { DEFAULT_CHAT_HEARTBEAT_MESSAGE, normalizeChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';

export class SetChatHeartbeatWorker extends BaseTool {
  name = '';
  description = '';

  protected _validatedCall(input: any): Promise<ToolResponse> {
    const threadId = String((this.state)?.metadata?.threadId || '').trim();
    if (!threadId) {
      return Promise.resolve({ successBoolean: false, responseString: 'This tool must be called from a chat thread.' });
    }

    const service = getChatHeartbeatService();
    // Threads with no open Desktop tab (relay chats, background threads) were never registered,
    // so the agent could not wake itself. Register them here on the thread's own channel; an open
    // tab re-registering later keeps this config and adds its UI callbacks.
    const current = service.status(threadId) ?? service.register({
      threadId,
      channel: String((this.state)?.metadata?.wsChannel || '').trim() || 'sulla-desktop',
      config:  normalizeChatHeartbeatConfig(null),
      busy:    false,
    });

    const rawMinutes = Number(input.intervalMinutes);
    const intervalMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : null;
    const message = typeof input.message === 'string' && input.message.trim()
      ? input.message.trim()
      : current.message || DEFAULT_CHAT_HEARTBEAT_MESSAGE;
    const status = service.configure(threadId, { intervalMinutes, message });

    return Promise.resolve({
      successBoolean: !!status,
      responseString: status?.enabled
        ? `This chat's heartbeat is on every ${ status.intervalMinutes } minute(s).`
        : 'This chat\'s heartbeat is off.',
    });
  }
}
