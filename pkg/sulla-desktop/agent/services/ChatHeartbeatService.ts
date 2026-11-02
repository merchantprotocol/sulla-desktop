// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';
import { GraphRegistry } from './GraphRegistry';
import { getWebSocketClientService } from './WebSocketClientService';
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';

let instance: ChatHeartbeatScheduler | null = null;

export function getChatHeartbeatService(): ChatHeartbeatScheduler {
  instance ??= new ChatHeartbeatScheduler({
    setActive: (threadId, active) => {
      const key = `chat-heartbeat:${ threadId }`;
      if (active) acquireChatActivity(key);
      else releaseChatActivity(key);
    },
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
