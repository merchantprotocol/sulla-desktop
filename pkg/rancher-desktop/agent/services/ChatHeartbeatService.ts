import { ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';
import { GraphRegistry } from './GraphRegistry';
import { getWebSocketClientService } from './WebSocketClientService';

let instance: ChatHeartbeatScheduler | null = null;

export function getChatHeartbeatService(): ChatHeartbeatScheduler {
  instance ??= new ChatHeartbeatScheduler({
    isGraphBusy: (threadId) => {
      const record = GraphRegistry.get(threadId);
      return !!record && record.state?.metadata?.cycleComplete !== true;
    },
    deliver: async(channel, threadId, message, intervalMinutes) => {
      const sent = await getWebSocketClientService().send(channel, {
        type: 'user_message',
        data: {
          role:     'user',
          content:  message,
          threadId,
          metadata: {
            source:      'chat_heartbeat',
            inputSource: 'system',
            intervalMinutes,
          },
        },
        timestamp: Date.now(),
      });
      return sent !== false;
    },
  });
  return instance;
}

export { ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';
