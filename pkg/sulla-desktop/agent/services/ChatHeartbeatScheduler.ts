// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatHeartbeatBusyWatchdog } from './ChatHeartbeatBusyWatchdog';
import { ChatHeartbeatExpiryService } from './ChatHeartbeatExpiryService';
import { HeartbeatNoticeBuilder } from './HeartbeatNoticeBuilder';
import {
  CHAT_HEARTBEAT_JOB_MIN_INTERVAL_MINUTES,
  normalizeChatHeartbeatConfig,
  type ChatHeartbeatBeat,
  type ChatHeartbeatConfig,
  type ChatHeartbeatStatus,
} from '@pkg/shared/chatHeartbeat';

const BUSY_RETRY_MS = 1_000;
export { STALE_BUSY_CHECK_MS, STALE_BUSY_LIMIT_MS } from './ChatHeartbeatBusyWatchdog';

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

export interface ChatHeartbeatRuntime extends ChatHeartbeatRegistration {
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
  pendingFinalBeat: { message: string; intervalMinutes: number; attempts: number } | null;
  finalDeliveryInFlight: boolean;
  generation: number;
}

export interface ChatHeartbeatJobTarget { jobId: string; taskIndex: number; }
export interface ChatHeartbeatJobSnapshot extends ChatHeartbeatJobTarget {
  threadId: string; channel: string; config: ChatHeartbeatConfig; startedAt: number; expiresAt: number;
}
export type ChatHeartbeatDeliveryResult = boolean | { delivered: boolean; terminal?: boolean; skipped?: boolean; queued?: boolean };
/** `final` marks the auto-off beat, which must be queued rather than dropped when its job task is busy. */
export interface ChatHeartbeatDeliveryOptions { final?: boolean; }
export type ChatHeartbeatDeliver = (channel: string, threadId: string, message: string, intervalMinutes: number,
  target?: ChatHeartbeatJobTarget, options?: ChatHeartbeatDeliveryOptions) => Promise<ChatHeartbeatDeliveryResult>;

export interface ChatHeartbeatSchedulerDeps {
  now?:        () => number;
  setTimer?:   typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  isGraphBusy: (threadId: string) => boolean;
  deliver:     ChatHeartbeatDeliver;
  setActive?:   (threadId: string, active: boolean) => void;
  hasPendingWait?: (target: ChatHeartbeatJobTarget) => Promise<boolean>;
  /** A job-bound heartbeat was set, switched off or expired; its durable record must follow. */
  jobHeartbeatChanged?: (threadId: string) => void;
  noticeBuilder?: HeartbeatNoticeBuilder;
}

export class ChatHeartbeatScheduler {
  private readonly runtimes = new Map<string, ChatHeartbeatRuntime>();
  private readonly expiry: ChatHeartbeatExpiryService;
  private readonly watchdog: ChatHeartbeatBusyWatchdog;
  private readonly now:        () => number;
  private readonly setTimer:   typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly deps: ChatHeartbeatSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.expiry = new ChatHeartbeatExpiryService({
      now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
      deliver: deps.deliver, setActive: deps.setActive,
      isCurrent: runtime => this.isCurrent(runtime),
      isBusy: runtime => runtime.busy || deps.isGraphBusy(runtime.threadId),
      watchForIdle: runtime => this.watchdog.start(runtime),
      jobHeartbeatChanged: deps.jobHeartbeatChanged,
      clearTimers: runtime => this.clearRuntimeTimers(runtime),
      unregisterJobTask: (jobId, taskIndex) => this.unregisterJobTask(jobId, taskIndex),
      emitStatus: runtime => this.emitStatus(runtime),
      hasPendingWait: deps.hasPendingWait,
      noticeBuilder: deps.noticeBuilder ?? new HeartbeatNoticeBuilder(),
    });
    this.watchdog = new ChatHeartbeatBusyWatchdog({
      now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
      isGraphBusy: deps.isGraphBusy, isCurrent: runtime => this.isCurrent(runtime),
      onStale: (runtime) => {
        if (runtime.pendingFinalBeat) void this.expiry.deliverPending(runtime);
        if (runtime.config.intervalMinutes !== null) this.resume(runtime);
        this.emitStatus(runtime);
      },
      onIdle: runtime => { void this.expiry.deliverPending(runtime) },
    });
  }

  /**
   * Registers a thread, or refreshes the one already registered. An existing runtime is updated
   * in place: an in-flight delivery holds a reference to it, and swapping the object would leave
   * that delivery rescheduling a timer nothing can ever cancel.
   */
  register(input: ChatHeartbeatRegistration): ChatHeartbeatStatus {
    const existing = this.runtimes.get(input.threadId);
    const runtime = existing ?? this.blankRuntime(input);
    this.clearRuntimeTimers(runtime);
    runtime.channel = input.channel;
    if (input.jobId) {
      runtime.jobId = input.jobId;
      runtime.taskIndex = input.taskIndex;
    }
    runtime.busy = input.busy ?? runtime.busy;
    runtime.onStatus = input.onStatus ?? runtime.onStatus;
    runtime.onBeat = input.onBeat ?? runtime.onBeat;
    runtime.onConfig = input.onConfig ?? runtime.onConfig;
    const requested = this.boundedConfig(runtime, existing && existing.config.intervalMinutes !== null
      ? existing.config
      : normalizeChatHeartbeatConfig(input.config));
    // A restored registration keeps its original deadline; one that already passed comes up off.
    const { startedAt, expiresAt } = this.expiry.resolveWindow(requested, existing);
    runtime.config = { ...requested, intervalMinutes: expiresAt === null ? null : requested.intervalMinutes, startedAt, expiresAt };
    runtime.startedAt = startedAt;
    runtime.expiresAt = expiresAt;
    runtime.paused = false;
    this.runtimes.set(input.threadId, runtime);
    this.deps.setActive?.(input.threadId, runtime.config.intervalMinutes !== null);
    if (runtime.busy) {
      this.pause(runtime);
      if (runtime.pendingFinalBeat) this.watchdog.start(runtime);
    } else {
      this.schedule(runtime, runtime.pending ? BUSY_RETRY_MS : undefined);
      if (runtime.pendingFinalBeat) void this.expiry.deliverPending(runtime);
    }
    this.expiry.schedule(runtime);
    runtime.onConfig?.(runtime.config);
    return this.emitStatus(runtime);
  }

  /** Binds an already-registered thread to its delegated job task (a composer-set heartbeat on a job thread). */
  bindJob(threadId: string, target: ChatHeartbeatJobTarget): void {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    runtime.jobId = target.jobId;
    runtime.taskIndex = target.taskIndex;
  }

  unregister(threadId: string): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime) this.clearRuntimeTimers(runtime);
    this.runtimes.delete(threadId);
    this.deps.setActive?.(threadId, false);
  }

  /** A closing tab must not cancel a delegated job's own heartbeat. */
  unregisterFromUi(threadId: string): void {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return;
    if (!runtime.jobId) return this.unregister(threadId);
    runtime.onStatus = runtime.onBeat = runtime.onConfig = undefined;
  }

  unregisterJobTask(jobId: string, taskIndex: number): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.jobId !== jobId || runtime.taskIndex !== taskIndex) continue;
      runtime.config = { ...runtime.config, intervalMinutes: null, startedAt: null, expiresAt: null };
      runtime.startedAt = runtime.expiresAt = null;
      runtime.onConfig?.(runtime.config);
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
    // Setting a heartbeat always opens a fresh window; only register() restores an old one.
    const fresh = { ...this.boundedConfig(runtime, normalizeChatHeartbeatConfig(config)), startedAt: null, expiresAt: null };
    const window = this.expiry.resolveWindow(fresh);
    runtime.config = { ...fresh, ...window };
    runtime.startedAt = window.startedAt;
    runtime.expiresAt = window.expiresAt;
    this.deps.setActive?.(threadId, runtime.config.intervalMinutes !== null);
    runtime.pending = false;
    runtime.onConfig?.(runtime.config);
    this.expiry.schedule(runtime);
    if (runtime.busy) this.pause(runtime);
    else this.schedule(runtime);
    if (this.expiry.targetFor(runtime)) this.deps.jobHeartbeatChanged?.(threadId);
    return this.emitStatus(runtime);
  }

  updateBusy(threadId: string, busy: boolean): ChatHeartbeatStatus | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return null;
    runtime.busy = busy;
    if (busy) {
      this.pause(runtime);
      if (runtime.pendingFinalBeat) this.watchdog.start(runtime);
    }
    else {
      if (runtime.pendingFinalBeat && this.deps.isGraphBusy(threadId)) this.watchdog.start(runtime);
      else this.watchdog.stop(runtime);
      if (runtime.paused) this.resume(runtime);
      if (runtime.pendingFinalBeat) void this.expiry.deliverPending(runtime);
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
    return this.expiry.activationNotice(runtime);
  }

  /** Snapshot needed by the provider's durable delegated-job repository. */
  jobHeartbeatRecord(threadId: string): ChatHeartbeatJobSnapshot | null {
    const runtime = this.runtimes.get(threadId);
    const target = this.jobTarget(threadId);
    if (!runtime || !target || runtime.config.intervalMinutes === null || runtime.startedAt === null || runtime.expiresAt === null) return null;
    return {
      ...target, threadId: runtime.threadId, channel: runtime.channel, config: { ...runtime.config },
      startedAt: runtime.startedAt, expiresAt: runtime.expiresAt,
    };
  }

  jobTarget(threadId: string): ChatHeartbeatJobTarget | undefined {
    const runtime = this.runtimes.get(threadId);
    return runtime ? this.expiry.targetFor(runtime) : undefined;
  }

  // A running graph is alive — it needs no ping. Stop the countdown and
  // drop any beat that came due; nothing is queued for when it stops.
  private pause(runtime: ChatHeartbeatRuntime): void {
    if (runtime.timer) this.clearTimer(runtime.timer);
    runtime.timer = null;
    runtime.nextAt = null;
    runtime.pending = false;
    runtime.paused = runtime.config.intervalMinutes !== null;
    if (runtime.busy && runtime.paused) this.watchdog.start(runtime);
    else this.watchdog.stop(runtime);
  }

  // The graph stopped: start a full interval from now, so the ping only
  // fires after the chat has sat idle for the whole interval.
  private resume(runtime: ChatHeartbeatRuntime): void {
    runtime.paused = false;
    this.schedule(runtime);
  }

  private schedule(runtime: ChatHeartbeatRuntime, delayMs?: number): void {
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
      if (!this.isCurrent(runtime)) return;
      this.attempt(runtime).catch(() => undefined);
    }, delay);
    runtime.timer.unref?.();
  }

  private clearRuntimeTimers(runtime: ChatHeartbeatRuntime): void {
    for (const timer of [runtime.timer, runtime.watchdog, runtime.expiryTimer]) if (timer) this.clearTimer(timer);
    runtime.timer = runtime.watchdog = runtime.expiryTimer = null;
    runtime.nextAt = null;
  }

  /** True only for the runtime the scheduler still owns; a replaced or unregistered one must go quiet. */
  private isCurrent(runtime: ChatHeartbeatRuntime): boolean {
    return this.runtimes.get(runtime.threadId) === runtime;
  }

  /** Delegated jobs are woken as whole turns, so they get a longer minimum interval than chats. */
  private boundedConfig(runtime: ChatHeartbeatRuntime, config: ChatHeartbeatConfig): ChatHeartbeatConfig {
    if (config.intervalMinutes === null || !this.expiry.targetFor(runtime)) return config;
    return { ...config, intervalMinutes: Math.max(CHAT_HEARTBEAT_JOB_MIN_INTERVAL_MINUTES, config.intervalMinutes) };
  }

  private blankRuntime(input: ChatHeartbeatRegistration): ChatHeartbeatRuntime {
    return {
      threadId: input.threadId, channel: input.channel, config: normalizeChatHeartbeatConfig(null),
      busy: false, pending: false, paused: false, nextAt: null, timer: null, delivering: false, watchdog: null,
      idleSince: null, startedAt: null, expiresAt: null, expiryTimer: null, expirationPending: false,
      expiring: false, pendingFinalBeat: null, finalDeliveryInFlight: false, generation: 0,
    };
  }

  private async attempt(runtime: ChatHeartbeatRuntime): Promise<void> {
    if (!this.isCurrent(runtime) || runtime.config.intervalMinutes === null || runtime.delivering) return;
    if (runtime.expiresAt !== null && this.now() >= runtime.expiresAt) {
      await this.expiry.expire(runtime);
      return;
    }
    if (runtime.busy || this.deps.isGraphBusy(runtime.threadId)) {
      // Graph started without the renderer telling us (e.g. another agent
      // woke it). Pause, and poll until it stops, then restart the countdown.
      this.pause(runtime);
      runtime.timer = this.setTimer(() => {
        runtime.timer = null;
        if (!this.isCurrent(runtime)) return;
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

    // The delivery can outlive this configuration: a job beat awaits the whole woken turn, which
    // is exactly when the agent switches its heartbeat off. Everything after the await re-reads
    // the runtime, and schedule() is a no-op once the heartbeat is off.
    const intervalMinutes = runtime.config.intervalMinutes;
    runtime.delivering = true;
    try {
      const content = await this.expiry.buildBeat(runtime);
      const result = await this.deps.deliver(runtime.channel, runtime.threadId, content,
        intervalMinutes, this.expiry.targetFor(runtime));
      if (typeof result !== 'boolean' && result.terminal) {
        this.unregisterJobTask(runtime.jobId ?? '', runtime.taskIndex ?? -1);
        return;
      }
      const skipped = typeof result !== 'boolean' && result.skipped === true;
      const delivered = typeof result === 'boolean' ? result : result.delivered;
      if (!delivered && !skipped) throw new Error('message bus rejected heartbeat');
      if (!this.isCurrent(runtime)) return;
      runtime.pending = false;
      // A skipped beat (task mid-turn, or children still running) is dropped, never retried as a new turn.
      if (!skipped) {
        runtime.onBeat?.({ threadId: runtime.threadId, createdAt: this.now(), intervalMinutes, message: content });
      }
      // The beat just woke the graph; if it's already running, stay paused
      // until it stops rather than counting down over the top of it.
      if (runtime.expirationPending) {
        runtime.expirationPending = false;
        await this.expiry.expire(runtime);
      } else if (runtime.busy) this.pause(runtime);
      else this.schedule(runtime);
    } catch (err) {
      console.warn(`[ChatHeartbeat] delivery failed for thread ${ runtime.threadId }:`, err);
      if (this.isCurrent(runtime) && runtime.config.intervalMinutes !== null) {
        runtime.pending = true;
        this.schedule(runtime, BUSY_RETRY_MS);
      }
    } finally {
      runtime.delivering = false;
      if (runtime.expirationPending) {
        runtime.expirationPending = false;
        this.expiry.expire(runtime).catch(error => console.warn(`[ChatHeartbeat] auto-off failed for thread ${ runtime.threadId }:`, error));
      }
      if (this.isCurrent(runtime)) this.emitStatus(runtime);
    }
  }

  private toStatus(runtime: ChatHeartbeatRuntime): ChatHeartbeatStatus {
    return {
      threadId:        runtime.threadId,
      ...runtime.config,
      enabled:         runtime.config.intervalMinutes !== null,
      nextAt:          runtime.nextAt,
      pending:         runtime.pending,
      startedAt:       runtime.startedAt,
      expiresAt:       runtime.expiresAt,
      paused:          runtime.paused,
    };
  }

  private emitStatus(runtime: ChatHeartbeatRuntime): ChatHeartbeatStatus {
    const status = this.toStatus(runtime);
    runtime.onStatus?.(status);
    return status;
  }
}
