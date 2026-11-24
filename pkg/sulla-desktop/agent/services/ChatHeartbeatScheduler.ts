// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  normalizeChatHeartbeatConfig,
  type ChatHeartbeatBeat,
  type ChatHeartbeatConfig,
  type ChatHeartbeatStatus,
} from '@pkg/shared/chatHeartbeat';

const BUSY_RETRY_MS = 1_000;
export const CHAT_HEARTBEAT_MAX_DURATION_MS = 6 * 60 * 60_000;
// How often a paused heartbeat re-checks a renderer "busy" claim against the
// backend, and how long the two may disagree before the claim is dropped.
export const STALE_BUSY_CHECK_MS = 15_000;
export const STALE_BUSY_LIMIT_MS = 60_000;

export interface ChatHeartbeatRegistration {
  threadId:  string;
  channel:   string;
  config:    ChatHeartbeatConfig;
  jobId?:    string;
  taskIndex?: number;
  busy?:     boolean;
  onStatus?: (status: ChatHeartbeatStatus) => void;
  onBeat?:   (beat: ChatHeartbeatBeat) => void;
  onConfig?: (config: ChatHeartbeatConfig) => void;
}

interface Runtime extends ChatHeartbeatRegistration {
  config:     ChatHeartbeatConfig;
  busy:       boolean;
  pending:    boolean;
  paused:     boolean;
  nextAt:     number | null;
  timer:      ReturnType<typeof setTimeout> | null;
  delivering: boolean;
  watchdog:   ReturnType<typeof setTimeout> | null;
  idleSince:  number | null;
  startedAt: number | null;
  expiresAt: number | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  expirationPending: boolean;
  expiring:   boolean;
  generation: number;
}

export interface ChatHeartbeatJobTarget { jobId: string; taskIndex: number; }
export type ChatHeartbeatDeliveryResult = boolean | { delivered: boolean; terminal?: boolean };

export interface ChatHeartbeatSchedulerDeps {
  now?:        () => number;
  setTimer?:   typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  isGraphBusy: (threadId: string) => boolean;
  deliver:     (channel: string, threadId: string, message: string, intervalMinutes: number, target?: ChatHeartbeatJobTarget) => Promise<ChatHeartbeatDeliveryResult>;
  setActive?:   (threadId: string, active: boolean) => void;
}

export class ChatHeartbeatScheduler {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly now:        () => number;
  private readonly setTimer:   typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly deps: ChatHeartbeatSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  register(input: ChatHeartbeatRegistration): ChatHeartbeatStatus {
    const existing = this.runtimes.get(input.threadId);
    if (existing?.timer) this.clearTimer(existing.timer);
    if (existing?.watchdog) this.clearTimer(existing.watchdog);
    if (existing?.expiryTimer) this.clearTimer(existing.expiryTimer);
    const config = existing && existing.config.intervalMinutes !== null
      ? existing.config
      : normalizeChatHeartbeatConfig(input.config);
    const enabled = config.intervalMinutes !== null;
    const startedAt = enabled ? existing?.startedAt ?? this.now() : null;
    const runtime: Runtime = {
      ...input,
      jobId:      input.jobId ?? existing?.jobId,
      taskIndex:  input.jobId ? input.taskIndex : existing?.taskIndex,
      config,
      busy:       input.busy ?? existing?.busy ?? false,
      pending:    existing?.pending ?? false,
      paused:     false,
      nextAt:     null,
      timer:      null,
      delivering: false,
      watchdog:   null,
      idleSince:  null,
      startedAt,
      expiresAt:  enabled ? existing?.expiresAt ?? startedAt! + CHAT_HEARTBEAT_MAX_DURATION_MS : null,
      expiryTimer: null,
      expirationPending: false,
      expiring:   false,
      generation: existing?.generation ?? 0,
      onStatus:   input.onStatus ?? existing?.onStatus,
      onBeat:     input.onBeat ?? existing?.onBeat,
      onConfig:   input.onConfig ?? existing?.onConfig,
    };
    this.runtimes.set(input.threadId, runtime);
    this.deps.setActive?.(input.threadId, runtime.config.intervalMinutes !== null);
    if (runtime.busy) this.pause(runtime);
    else this.schedule(runtime, runtime.pending ? BUSY_RETRY_MS : undefined);
    this.scheduleExpiry(runtime);
    runtime.onConfig?.(runtime.config);
    return this.emitStatus(runtime);
  }

  unregister(threadId: string): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime?.timer) this.clearTimer(runtime.timer);
    if (runtime?.watchdog) this.clearTimer(runtime.watchdog);
    if (runtime?.expiryTimer) this.clearTimer(runtime.expiryTimer);
    this.runtimes.delete(threadId);
    this.deps.setActive?.(threadId, false);
  }

  /** A closing tab must not cancel a delegated job's own heartbeat. */
  unregisterFromUi(threadId: string): void {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    if (!runtime.jobId) {
      this.unregister(threadId);
      return;
    }
    runtime.onStatus = undefined;
    runtime.onBeat = undefined;
    runtime.onConfig = undefined;
  }

  unregisterJobTask(jobId: string, taskIndex: number): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.jobId !== jobId || runtime.taskIndex !== taskIndex) continue;
      const off = { ...runtime.config, intervalMinutes: null };
      runtime.config = off;
      runtime.startedAt = null;
      runtime.expiresAt = null;
      runtime.onConfig?.(off);
      this.emitStatus(runtime);
      this.unregister(runtime.threadId);
    }
  }

  has(threadId: string): boolean {
    return this.runtimes.has(threadId);
  }

  configure(threadId: string, config: ChatHeartbeatConfig): ChatHeartbeatStatus | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return null;
    const previousGeneration = runtime.generation;
    runtime.generation = previousGeneration + 1;
    runtime.expiring = false;
    runtime.expirationPending = false;
    if (runtime.expiryTimer) this.clearTimer(runtime.expiryTimer);
    runtime.expiryTimer = null;
    runtime.config = normalizeChatHeartbeatConfig(config);
    this.deps.setActive?.(threadId, runtime.config.intervalMinutes !== null);
    runtime.pending = false;
    runtime.startedAt = runtime.config.intervalMinutes === null ? null : this.now();
    runtime.expiresAt = runtime.startedAt === null ? null : runtime.startedAt + CHAT_HEARTBEAT_MAX_DURATION_MS;
    runtime.onConfig?.(runtime.config);
    this.scheduleExpiry(runtime);
    if (runtime.busy) this.pause(runtime);
    else this.schedule(runtime);
    return this.emitStatus(runtime);
  }

  updateBusy(threadId: string, busy: boolean): ChatHeartbeatStatus | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return null;
    runtime.busy = busy;
    if (busy) this.pause(runtime);
    else {
      this.stopWatchdog(runtime);
      if (runtime.paused) this.resume(runtime);
    }
    return this.emitStatus(runtime);
  }

  status(threadId: string): ChatHeartbeatStatus | null {
    const runtime = this.runtimes.get(threadId);
    return runtime ? this.toStatus(runtime) : null;
  }

  activationNotice(threadId: string): string | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime?.config.intervalMinutes || runtime.startedAt === null || runtime.expiresAt === null) return null;
    return this.systemNotice(runtime.config.intervalMinutes, runtime.startedAt, runtime.expiresAt);
  }

  // A running graph is alive — it needs no ping. Stop the countdown and
  // drop any beat that came due; nothing is queued for when it stops.
  private pause(runtime: Runtime): void {
    if (runtime.timer) this.clearTimer(runtime.timer);
    runtime.timer = null;
    runtime.nextAt = null;
    runtime.pending = false;
    runtime.paused = runtime.config.intervalMinutes !== null;
    if (runtime.busy && runtime.paused) this.startWatchdog(runtime);
    else this.stopWatchdog(runtime);
  }

  // A turn that dies on an error can leave the renderer claiming "busy"
  // forever, which would pause the heartbeat for good — exactly when the
  // chat most needs waking. The backend graph is the source of truth: once
  // it has had no live turn for STALE_BUSY_LIMIT_MS, drop the stale claim.
  private startWatchdog(runtime: Runtime): void {
    if (runtime.watchdog) return;
    runtime.idleSince = null;
    const check = () => {
      runtime.watchdog = null;
      if (!this.runtimes.has(runtime.threadId) || !runtime.busy || runtime.config.intervalMinutes === null) {
        runtime.idleSince = null;
        return;
      }
      if (this.deps.isGraphBusy(runtime.threadId)) {
        runtime.idleSince = null;
      } else {
        runtime.idleSince ??= this.now();
        if (this.now() - runtime.idleSince >= STALE_BUSY_LIMIT_MS) {
          console.warn(`[ChatHeartbeat] thread ${ runtime.threadId } reported busy but its graph is idle; resuming heartbeat`);
          runtime.busy = false;
          runtime.idleSince = null;
          this.resume(runtime);
          this.emitStatus(runtime);
          return;
        }
      }
      runtime.watchdog = this.setTimer(check, STALE_BUSY_CHECK_MS);
      runtime.watchdog.unref?.();
    };
    runtime.watchdog = this.setTimer(check, STALE_BUSY_CHECK_MS);
    runtime.watchdog.unref?.();
  }

  private stopWatchdog(runtime: Runtime): void {
    if (runtime.watchdog) this.clearTimer(runtime.watchdog);
    runtime.watchdog = null;
    runtime.idleSince = null;
  }

  // The graph stopped: start a full interval from now, so the ping only
  // fires after the chat has sat idle for the whole interval.
  private resume(runtime: Runtime): void {
    runtime.paused = false;
    this.schedule(runtime);
  }

  private schedule(runtime: Runtime, delayMs?: number): void {
    if (runtime.timer) this.clearTimer(runtime.timer);
    runtime.timer = null;
    runtime.nextAt = null;
    if (runtime.config.intervalMinutes === null) {
      runtime.pending = false;
      return;
    }
    const delay = delayMs ?? runtime.config.intervalMinutes * 60_000;
    runtime.nextAt = runtime.pending ? null : this.now() + delay;
    runtime.timer = this.setTimer(() => {
      runtime.timer = null;
      runtime.nextAt = null;
      this.attempt(runtime).catch(() => undefined);
    }, delay);
    runtime.timer.unref?.();
  }

  private scheduleExpiry(runtime: Runtime): void {
    if (runtime.expiryTimer) this.clearTimer(runtime.expiryTimer);
    runtime.expiryTimer = null;
    if (runtime.config.intervalMinutes === null || runtime.expiresAt === null) return;
    const generation = runtime.generation;
    runtime.expiryTimer = this.setTimer(() => {
      runtime.expiryTimer = null;
      if (runtime.generation !== generation) return;
      if (runtime.delivering) {
        runtime.expirationPending = true;
        return;
      }
      this.expire(runtime).catch(error => console.warn(`[ChatHeartbeat] auto-off failed for thread ${ runtime.threadId }:`, error));
    }, Math.max(0, runtime.expiresAt - this.now()));
    runtime.expiryTimer.unref?.();
  }

  private async expire(runtime: Runtime): Promise<void> {
    if (!this.runtimes.has(runtime.threadId) || runtime.config.intervalMinutes === null || runtime.expiring) return;
    const intervalMinutes = runtime.config.intervalMinutes;
    const message = runtime.config.message;
    const startedAt = runtime.startedAt ?? this.now();
    const expiresAt = runtime.expiresAt ?? this.now();
    const generation = runtime.generation;
    runtime.expiring = true;
    this.clearRuntimeTimers(runtime);

    // Switch off before delivery: even a slow final wake cannot leave a live timer behind.
    runtime.config = { ...runtime.config, intervalMinutes: null };
    runtime.startedAt = null;
    runtime.expiresAt = null;
    runtime.pending = false;
    runtime.paused = false;
    this.deps.setActive?.(runtime.threadId, false);
    runtime.onConfig?.(runtime.config);
    this.emitStatus(runtime);

    const finalMessage = `${ message }\n\n${ this.systemNotice(intervalMinutes, startedAt, expiresAt) }\n\nSystem: your heartbeat was switched off automatically after 6 hours. If the work it was watching is still open, turn it back on with sulla chat/set_heartbeat '{"intervalMinutes":${ intervalMinutes },"message":"..."}'.`;
    try {
      const result = await this.deps.deliver(runtime.channel, runtime.threadId, finalMessage, intervalMinutes, this.jobTarget(runtime));
      const delivered = typeof result === 'boolean' ? result : result.delivered;
      if (typeof result !== 'boolean' && result.terminal) {
        this.unregisterJobTask(runtime.jobId ?? '', runtime.taskIndex ?? -1);
        return;
      }
      if (delivered && this.runtimes.has(runtime.threadId)) {
        runtime.onBeat?.({ threadId: runtime.threadId, createdAt: this.now(), intervalMinutes, message: finalMessage, autoOff: true });
      } else if (!delivered) {
        console.warn(`[ChatHeartbeat] final beat was not delivered for thread ${ runtime.threadId }`);
      }
    } catch (error) {
      console.warn(`[ChatHeartbeat] final beat failed for thread ${ runtime.threadId }:`, error);
    } finally {
      if (runtime.generation === generation && this.runtimes.has(runtime.threadId)) {
        runtime.expiring = false;
        this.emitStatus(runtime);
      }
    }
  }

  private clearRuntimeTimers(runtime: Runtime): void {
    if (runtime.timer) this.clearTimer(runtime.timer);
    if (runtime.watchdog) this.clearTimer(runtime.watchdog);
    if (runtime.expiryTimer) this.clearTimer(runtime.expiryTimer);
    runtime.timer = null;
    runtime.watchdog = null;
    runtime.expiryTimer = null;
    runtime.nextAt = null;
  }

  private systemNotice(intervalMinutes: number, startedAt: number, expiresAt: number): string {
    return `System: this is your heartbeat (every ${ intervalMinutes } min, set at ${ new Date(startedAt).toISOString() }, switches off automatically at ${ new Date(expiresAt).toISOString() }). Turn it off as soon as the work it watches is finished: sulla chat/set_heartbeat '{"intervalMinutes":0}'.`;
  }

  private jobTarget(runtime: Runtime): ChatHeartbeatJobTarget | undefined {
    return runtime.jobId && runtime.taskIndex !== undefined ? { jobId: runtime.jobId, taskIndex: runtime.taskIndex } : undefined;
  }

  private async attempt(runtime: Runtime): Promise<void> {
    if (!this.runtimes.has(runtime.threadId) || runtime.config.intervalMinutes === null || runtime.delivering) return;
    if (runtime.expiresAt !== null && this.now() >= runtime.expiresAt) {
      await this.expire(runtime);
      return;
    }
    if (runtime.busy || this.deps.isGraphBusy(runtime.threadId)) {
      // Graph started without the renderer telling us (e.g. another agent
      // woke it). Pause, and poll until it stops, then restart the countdown.
      this.pause(runtime);
      runtime.timer = this.setTimer(() => {
        runtime.timer = null;
        if (!this.runtimes.has(runtime.threadId)) return;
        if (runtime.busy || this.deps.isGraphBusy(runtime.threadId)) {
          this.attempt(runtime).catch(() => undefined);
          return;
        }
        this.resume(runtime);
        this.emitStatus(runtime);
      }, BUSY_RETRY_MS);
      runtime.timer.unref?.();
      this.emitStatus(runtime);
      return;
    }

    runtime.delivering = true;
    try {
      const content = `${ runtime.config.message }\n\n${ this.systemNotice(runtime.config.intervalMinutes, runtime.startedAt ?? this.now(), runtime.expiresAt ?? this.now()) }`;
      const result = await this.deps.deliver(
        runtime.channel,
        runtime.threadId,
        content,
        runtime.config.intervalMinutes,
        this.jobTarget(runtime),
      );
      if (typeof result !== 'boolean' && result.terminal) {
        this.unregisterJobTask(runtime.jobId ?? '', runtime.taskIndex ?? -1);
        return;
      }
      const delivered = typeof result === 'boolean' ? result : result.delivered;
      if (!delivered) throw new Error('message bus rejected heartbeat');
      runtime.pending = false;
      runtime.onBeat?.({
        threadId:        runtime.threadId,
        createdAt:       this.now(),
        intervalMinutes: runtime.config.intervalMinutes,
        message:         content,
      });
      // The beat just woke the graph; if it's already running, stay paused
      // until it stops rather than counting down over the top of it.
      if (runtime.expirationPending) {
        runtime.expirationPending = false;
        await this.expire(runtime);
      } else if (runtime.busy) this.pause(runtime);
      else this.schedule(runtime);
    } catch (err) {
      console.warn(`[ChatHeartbeat] delivery failed for thread ${ runtime.threadId }:`, err);
      runtime.pending = true;
      this.schedule(runtime, BUSY_RETRY_MS);
    } finally {
      runtime.delivering = false;
      if (runtime.expirationPending) {
        runtime.expirationPending = false;
        this.expire(runtime).catch(error => console.warn(`[ChatHeartbeat] auto-off failed for thread ${ runtime.threadId }:`, error));
      }
      if (this.runtimes.has(runtime.threadId)) this.emitStatus(runtime);
    }
  }

  private toStatus(runtime: Runtime): ChatHeartbeatStatus {
    return {
      threadId:        runtime.threadId,
      enabled:         runtime.config.intervalMinutes !== null,
      intervalMinutes: runtime.config.intervalMinutes,
      message:         runtime.config.message,
      nextAt:          runtime.nextAt,
      pending:         runtime.pending,
      startedAt:       runtime.startedAt,
      expiresAt:       runtime.expiresAt,
      paused:          runtime.paused,
    };
  }

  private emitStatus(runtime: Runtime): ChatHeartbeatStatus {
    const status = this.toStatus(runtime);
    runtime.onStatus?.(status);
    return status;
  }
}
