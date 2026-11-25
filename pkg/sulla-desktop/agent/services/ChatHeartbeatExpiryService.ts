// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CHAT_HEARTBEAT_MAX_DURATION_MS, type ChatHeartbeatConfig, type ChatHeartbeatStatus } from '@pkg/shared/chatHeartbeat';

import type { ChatHeartbeatDeliver, ChatHeartbeatJobTarget, ChatHeartbeatRuntime } from './ChatHeartbeatScheduler';
import { HeartbeatNoticeBuilder } from './HeartbeatNoticeBuilder';

/** Owns each heartbeat's bounded six-hour window and its final delivery. */
export class ChatHeartbeatExpiryService {
  constructor(private readonly deps: {
    now: () => number;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
    deliver: ChatHeartbeatDeliver;
    setActive?: (threadId: string, active: boolean) => void;
    isCurrent: (runtime: ChatHeartbeatRuntime) => boolean;
    isBusy?: (runtime: ChatHeartbeatRuntime) => boolean;
    watchForIdle?: (runtime: ChatHeartbeatRuntime) => void;
    jobHeartbeatChanged?: (threadId: string) => void;
    clearTimers: (runtime: ChatHeartbeatRuntime) => void;
    unregisterJobTask: (jobId: string, taskIndex: number) => void;
    emitStatus: (runtime: ChatHeartbeatRuntime) => ChatHeartbeatStatus;
    hasPendingWait?: (target: ChatHeartbeatJobTarget) => Promise<boolean>;
    noticeBuilder: HeartbeatNoticeBuilder;
  }) {}

  /**
   * The window a (re)registration runs in. A live runtime or a persisted config keeps its
   * original deadline; nulls mean off, including a restored deadline that already passed.
   */
  resolveWindow(config: ChatHeartbeatConfig, existing?: { startedAt: number | null; expiresAt: number | null }): {
    startedAt: number | null; expiresAt: number | null;
  } {
    if (config.intervalMinutes === null) return { startedAt: null, expiresAt: null };
    const now = this.deps.now();
    const expiresAt = existing?.expiresAt ?? config.expiresAt
      ?? (existing?.startedAt ?? config.startedAt ?? now) + CHAT_HEARTBEAT_MAX_DURATION_MS;
    if (expiresAt <= now) return { startedAt: null, expiresAt: null };
    return { startedAt: existing?.startedAt ?? config.startedAt ?? expiresAt - CHAT_HEARTBEAT_MAX_DURATION_MS, expiresAt };
  }

  schedule(runtime: ChatHeartbeatRuntime): void {
    if (runtime.expiryTimer) this.deps.clearTimer(runtime.expiryTimer);
    runtime.expiryTimer = null;
    if (runtime.config.intervalMinutes === null || runtime.expiresAt === null) return;
    const generation = runtime.generation;
    runtime.expiryTimer = this.deps.setTimer(() => {
      runtime.expiryTimer = null;
      if (runtime.generation !== generation || !this.deps.isCurrent(runtime)) return;
      if (runtime.delivering) {
        runtime.expirationPending = true;
        return;
      }
      this.expire(runtime).catch(error => console.warn(`[ChatHeartbeat] auto-off failed for thread ${ runtime.threadId }:`, error));
    }, Math.max(0, runtime.expiresAt - this.deps.now()));
    runtime.expiryTimer.unref?.();
  }

  async expire(runtime: ChatHeartbeatRuntime): Promise<void> {
    if (!this.deps.isCurrent(runtime) || runtime.config.intervalMinutes === null || runtime.expiring) return;
    const intervalMinutes = runtime.config.intervalMinutes;
    const message = runtime.config.message;
    const startedAt = runtime.startedAt ?? this.deps.now();
    const expiresAt = runtime.expiresAt ?? this.deps.now();
    const generation = runtime.generation;
    const target = this.targetFor(runtime);
    runtime.expiring = true;
    this.deps.clearTimers(runtime);

    // Switch off before delivery: even a slow final wake cannot leave a live timer behind.
    runtime.config = { ...runtime.config, intervalMinutes: null, startedAt: null, expiresAt: null };
    runtime.startedAt = null;
    runtime.expiresAt = null;
    runtime.pending = false;
    runtime.paused = false;
    this.deps.setActive?.(runtime.threadId, false);
    runtime.onConfig?.(runtime.config);
    this.deps.emitStatus(runtime);
    // The durable job record goes now, not at the next restart: nothing may rehydrate an expired heartbeat.
    if (target) this.deps.jobHeartbeatChanged?.(runtime.threadId);

    try {
      const finalMessage = await this.buildMessage(runtime, message, intervalMinutes, startedAt, expiresAt, true);
      if (!target && this.deps.isBusy?.(runtime)) {
        runtime.pendingFinalBeat = { message: finalMessage, intervalMinutes, attempts: 0 };
        this.deps.watchForIdle?.(runtime);
        return;
      }
      await this.deliverFinal(runtime, finalMessage, intervalMinutes, target);
    } finally {
      if (runtime.generation === generation && this.deps.isCurrent(runtime)) {
        runtime.expiring = false;
        this.deps.emitStatus(runtime);
      }
    }
  }

  /** Deliver a deferred chat auto-off notice only once its graph is idle. */
  async deliverPending(runtime: ChatHeartbeatRuntime): Promise<void> {
    const pending = runtime.pendingFinalBeat;
    if (!pending || runtime.finalDeliveryInFlight || !this.deps.isCurrent(runtime)) return;
    if (this.deps.isBusy?.(runtime)) {
      this.deps.watchForIdle?.(runtime);
      return;
    }
    runtime.finalDeliveryInFlight = true;
    pending.attempts += 1;
    try {
      const delivered = await this.deliverFinal(runtime, pending.message, pending.intervalMinutes);
      if (runtime.pendingFinalBeat !== pending) return;
      if (delivered || pending.attempts >= 2) runtime.pendingFinalBeat = null;
    } catch (error) {
      if (pending.attempts >= 2 && runtime.pendingFinalBeat === pending) runtime.pendingFinalBeat = null;
      console.warn(`[ChatHeartbeat] deferred final beat failed for thread ${ runtime.threadId }:`, error);
    } finally {
      runtime.finalDeliveryInFlight = false;
      if (this.deps.isCurrent(runtime)) this.deps.emitStatus(runtime);
    }
  }

  buildBeat(runtime: ChatHeartbeatRuntime): Promise<string> {
    const intervalMinutes = runtime.config.intervalMinutes;
    if (intervalMinutes === null) return Promise.resolve(runtime.config.message);
    const startedAt = runtime.startedAt ?? this.deps.now();
    const expiresAt = runtime.expiresAt ?? this.deps.now();
    return this.buildMessage(runtime, runtime.config.message, intervalMinutes, startedAt, expiresAt);
  }

  activationNotice(runtime: ChatHeartbeatRuntime): string | null {
    const intervalMinutes = runtime.config.intervalMinutes;
    if (intervalMinutes === null || runtime.startedAt === null || runtime.expiresAt === null) return null;
    return this.deps.noticeBuilder.buildNotice({
      intervalMinutes, startedAt: runtime.startedAt, expiresAt: runtime.expiresAt,
      setBy: runtime.config.setBy ?? 'human',
    });
  }

  targetFor(runtime: ChatHeartbeatRuntime): ChatHeartbeatJobTarget | undefined {
    return runtime.jobId && runtime.taskIndex !== undefined ? { jobId: runtime.jobId, taskIndex: runtime.taskIndex } : undefined;
  }

  private async buildMessage(runtime: ChatHeartbeatRuntime, message: string, intervalMinutes: number,
    startedAt: number, expiresAt: number, autoOff = false): Promise<string> {
    const pendingWait = await this.pendingWait(this.targetFor(runtime));
    return this.deps.noticeBuilder.buildMessage({
      message, intervalMinutes, startedAt, expiresAt,
      setBy: runtime.config.setBy ?? 'human', pendingWait, autoOff,
    });
  }

  private async pendingWait(target: ChatHeartbeatJobTarget | undefined): Promise<boolean> {
    if (!target || !this.deps.hasPendingWait) return false;
    try {
      return await this.deps.hasPendingWait(target);
    } catch (error) {
      console.warn(`[ChatHeartbeat] could not inspect pending wait for job ${ target.jobId }:`, error);
      return false;
    }
  }

  private async deliverFinal(runtime: ChatHeartbeatRuntime, message: string, intervalMinutes: number,
    target?: ChatHeartbeatJobTarget): Promise<boolean> {
    try {
      const result = await this.deps.deliver(runtime.channel, runtime.threadId, message, intervalMinutes, target, { final: true });
      const delivered = typeof result === 'boolean' ? result : result.delivered;
      if (typeof result !== 'boolean' && result.terminal) {
        this.deps.unregisterJobTask(runtime.jobId ?? '', runtime.taskIndex ?? -1);
        return true;
      }
      if (delivered && this.deps.isCurrent(runtime)) {
        runtime.onBeat?.({ threadId: runtime.threadId, createdAt: this.deps.now(), intervalMinutes, message, autoOff: true });
      } else if (!delivered) {
        console.warn(`[ChatHeartbeat] final beat was not delivered for thread ${ runtime.threadId }`);
      }
      return delivered;
    } catch (error) {
      console.warn(`[ChatHeartbeat] final beat failed for thread ${ runtime.threadId }:`, error);
      return false;
    }
  }
}
