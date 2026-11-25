// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  CHAT_HEARTBEAT_JOB_MIN_INTERVAL_MINUTES,
  normalizeChatHeartbeatConfig,
  type ChatHeartbeatConfig,
} from '@pkg/shared/chatHeartbeat';

import type { ChatHeartbeatJobTarget, ChatHeartbeatRegistration, ChatHeartbeatRuntime } from './ChatHeartbeatScheduler';

/** Builds the default runtime state and applies job-specific interval bounds. */
export class ChatHeartbeatRuntimeFactory {
  constructor(private readonly jobMinimumIntervalMinutes = CHAT_HEARTBEAT_JOB_MIN_INTERVAL_MINUTES) {}

  create(input: ChatHeartbeatRegistration): ChatHeartbeatRuntime {
    return {
      threadId: input.threadId, channel: input.channel, config: normalizeChatHeartbeatConfig(null),
      busy: false, pending: false, paused: false, nextAt: null, timer: null, delivering: false, watchdog: null,
      idleSince: null, startedAt: null, expiresAt: null, expiryTimer: null, expirationPending: false,
      expiring: false, pendingFinalBeat: null, finalDeliveryInFlight: false, generation: 0,
    };
  }

  boundConfig(config: ChatHeartbeatConfig, target: ChatHeartbeatJobTarget | undefined): ChatHeartbeatConfig {
    if (config.intervalMinutes === null || !target) return config;
    return { ...config, intervalMinutes: Math.max(this.jobMinimumIntervalMinutes, config.intervalMinutes) };
  }
}
