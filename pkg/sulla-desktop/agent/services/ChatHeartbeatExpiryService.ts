// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatHeartbeatBeat, ChatHeartbeatStatus } from '@pkg/shared/chatHeartbeat';

import type { ChatHeartbeatDeliveryResult, ChatHeartbeatJobTarget, ChatHeartbeatRuntime } from './ChatHeartbeatScheduler';

/** Owns each heartbeat's bounded six-hour window and its final delivery. */
export class ChatHeartbeatExpiryService {
  constructor(private readonly deps: {
    now: () => number;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
    deliver: (channel: string, threadId: string, message: string, intervalMinutes: number, target?: ChatHeartbeatJobTarget) => Promise<ChatHeartbeatDeliveryResult>;
    setActive?: (threadId: string, active: boolean) => void;
    isRegistered: (threadId: string) => boolean;
    clearTimers: (runtime: ChatHeartbeatRuntime) => void;
    unregisterJobTask: (jobId: string, taskIndex: number) => void;
    emitStatus: (runtime: ChatHeartbeatRuntime) => ChatHeartbeatStatus;
  }) {}

  schedule(runtime: ChatHeartbeatRuntime): void {
    if (runtime.expiryTimer) this.deps.clearTimer(runtime.expiryTimer);
    runtime.expiryTimer = null;
    if (runtime.config.intervalMinutes === null || runtime.expiresAt === null) return;
    const generation = runtime.generation;
    runtime.expiryTimer = this.deps.setTimer(() => {
      runtime.expiryTimer = null;
      if (runtime.generation !== generation) return;
      if (runtime.delivering) {
        runtime.expirationPending = true;
        return;
      }
      this.expire(runtime).catch(error => console.warn(`[ChatHeartbeat] auto-off failed for thread ${ runtime.threadId }:`, error));
    }, Math.max(0, runtime.expiresAt - this.deps.now()));
    runtime.expiryTimer.unref?.();
  }

  async expire(runtime: ChatHeartbeatRuntime): Promise<void> {
    if (!this.deps.isRegistered(runtime.threadId) || runtime.config.intervalMinutes === null || runtime.expiring) return;
    const intervalMinutes = runtime.config.intervalMinutes;
    const message = runtime.config.message;
    const startedAt = runtime.startedAt ?? this.deps.now();
    const expiresAt = runtime.expiresAt ?? this.deps.now();
    const generation = runtime.generation;
    runtime.expiring = true;
    this.deps.clearTimers(runtime);

    // Switch off before delivery: even a slow final wake cannot leave a live timer behind.
    runtime.config = { ...runtime.config, intervalMinutes: null };
    runtime.startedAt = null;
    runtime.expiresAt = null;
    runtime.pending = false;
    runtime.paused = false;
    this.deps.setActive?.(runtime.threadId, false);
    runtime.onConfig?.(runtime.config);
    this.deps.emitStatus(runtime);

    const finalMessage = `${ message }\n\n${ this.notice(intervalMinutes, startedAt, expiresAt) }\n\nSystem: your heartbeat was switched off automatically after 6 hours. If the work it was watching is still open, turn it back on with sulla chat/set_heartbeat '{"intervalMinutes":${ intervalMinutes },"message":"..."}'.`;
    try {
      const result = await this.deps.deliver(runtime.channel, runtime.threadId, finalMessage, intervalMinutes, this.targetFor(runtime));
      const delivered = typeof result === 'boolean' ? result : result.delivered;
      if (typeof result !== 'boolean' && result.terminal) {
        this.deps.unregisterJobTask(runtime.jobId ?? '', runtime.taskIndex ?? -1);
        return;
      }
      if (delivered && this.deps.isRegistered(runtime.threadId)) {
        runtime.onBeat?.({ threadId: runtime.threadId, createdAt: this.deps.now(), intervalMinutes, message: finalMessage, autoOff: true });
      } else if (!delivered) {
        console.warn(`[ChatHeartbeat] final beat was not delivered for thread ${ runtime.threadId }`);
      }
    } catch (error) {
      console.warn(`[ChatHeartbeat] final beat failed for thread ${ runtime.threadId }:`, error);
    } finally {
      if (runtime.generation === generation && this.deps.isRegistered(runtime.threadId)) {
        runtime.expiring = false;
        this.deps.emitStatus(runtime);
      }
    }
  }

  notice(intervalMinutes: number, startedAt: number, expiresAt: number): string {
    return `System: this is your heartbeat (every ${ intervalMinutes } min, set at ${ new Date(startedAt).toISOString() }, switches off automatically at ${ new Date(expiresAt).toISOString() }). Turn it off as soon as the work it watches is finished: sulla chat/set_heartbeat '{"intervalMinutes":0}'.`;
  }

  targetFor(runtime: ChatHeartbeatRuntime): ChatHeartbeatJobTarget | undefined {
    return runtime.jobId && runtime.taskIndex !== undefined ? { jobId: runtime.jobId, taskIndex: runtime.taskIndex } : undefined;
  }
}
