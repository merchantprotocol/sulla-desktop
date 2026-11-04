// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentDefinitionService } from './AgentDefinitionService';
import { AgentHeartbeatPolicy } from './AgentHeartbeatPolicy';
import { ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';
import { GraphRegistry } from './GraphRegistry';
import { agentJobLifecycle } from './AgentJobLifecycleService';
import { getBackendGraphWebSocketService } from './BackendGraphWebSocketService';
import { JobHeartbeatDelivery } from './JobHeartbeatDelivery';
import { getWebSocketClientService } from './WebSocketClientService';
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';
import { findTaskByThread } from '../tools/agents/jobRegistry';

import { frontendGraphLogger as console } from '@pkg/agent/utils/agentLogger';

let instance: ChatHeartbeatScheduler | null = null;

const jobHeartbeatDelivery = new JobHeartbeatDelivery(
  { findTaskByThread },
  new AgentHeartbeatPolicy(agentDefinitionService),
  (channelId, threadId, message, agentId, messageMeta) => getBackendGraphWebSocketService().wakeParkedAgent(channelId, threadId, message, agentId, messageMeta),
  (threadId) => instance?.unregister(threadId),
  (message) => console.warn(message),
);

async function deliverToTab(channel: string, threadId: string, message: string, intervalMinutes: number): Promise<boolean> {
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
}

export function getChatHeartbeatService(): ChatHeartbeatScheduler {
  instance ??= new ChatHeartbeatScheduler({
    setActive: (threadId, active) => {
      const key = `chat-heartbeat:${ threadId }`;
      if (active) acquireChatActivity(key);
      else releaseChatActivity(key);
    },
    isGraphBusy: (threadId) => {
      // A manager parked mid in-process wait for its own children owns that
      // turn's lifecycle itself: it is safe to inject a heartbeat into it and
      // wake it (JobHeartbeatDelivery/wakeParkedAgent do exactly that), not
      // busy in the sense this check exists for. Checked first because the
      // cycleComplete flag below stays false for the whole outer turn that
      // in-process wait is blocked inside, which would otherwise pause the
      // heartbeat indefinitely instead of ever delivering it.
      if (agentJobLifecycle.hasLiveWaiter(threadId)) return false;
      const record = GraphRegistry.get(threadId);
      return !!record && record.state?.metadata?.cycleComplete !== true;
    },
    deliver: async(channel, threadId, message, intervalMinutes) => {
      const outcome = await jobHeartbeatDelivery.tryDeliver(channel, threadId, message, intervalMinutes);
      return outcome.applicable ? outcome.delivered : deliverToTab(channel, threadId, message, intervalMinutes);
    },
  });
  return instance;
}

export { ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';
