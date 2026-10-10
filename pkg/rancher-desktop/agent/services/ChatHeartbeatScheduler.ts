import {
  normalizeChatHeartbeatConfig,
  type ChatHeartbeatBeat,
  type ChatHeartbeatConfig,
  type ChatHeartbeatStatus,
} from '@pkg/shared/chatHeartbeat';

const BUSY_RETRY_MS = 1_000;

export interface ChatHeartbeatRegistration {
  threadId:  string;
  channel:   string;
  config:    ChatHeartbeatConfig;
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
}

export interface ChatHeartbeatSchedulerDeps {
  now?:        () => number;
  setTimer?:   typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  isGraphBusy: (threadId: string) => boolean;
  deliver:     (channel: string, threadId: string, message: string, intervalMinutes: number) => Promise<boolean>;
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
    const runtime: Runtime = {
      ...input,
      config:     existing?.config ?? normalizeChatHeartbeatConfig(input.config),
      busy:       !!input.busy,
      pending:    existing?.pending ?? false,
      paused:     false,
      nextAt:     null,
      timer:      null,
      delivering: false,
    };
    this.runtimes.set(input.threadId, runtime);
    if (runtime.busy) this.pause(runtime);
    else this.schedule(runtime, runtime.pending ? BUSY_RETRY_MS : undefined);
    return this.emitStatus(runtime);
  }

  unregister(threadId: string): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime?.timer) this.clearTimer(runtime.timer);
    this.runtimes.delete(threadId);
  }

  has(threadId: string): boolean {
    return this.runtimes.has(threadId);
  }

  configure(threadId: string, config: ChatHeartbeatConfig): ChatHeartbeatStatus | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return null;
    runtime.config = normalizeChatHeartbeatConfig(config);
    runtime.pending = false;
    runtime.onConfig?.(runtime.config);
    if (runtime.busy) this.pause(runtime);
    else this.schedule(runtime);
    return this.emitStatus(runtime);
  }

  updateBusy(threadId: string, busy: boolean): ChatHeartbeatStatus | null {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) return null;
    runtime.busy = busy;
    if (busy) this.pause(runtime);
    else if (runtime.paused) this.resume(runtime);
    return this.emitStatus(runtime);
  }

  status(threadId: string): ChatHeartbeatStatus | null {
    const runtime = this.runtimes.get(threadId);
    return runtime ? this.toStatus(runtime) : null;
  }

  // A running graph is alive — it needs no ping. Stop the countdown and
  // drop any beat that came due; nothing is queued for when it stops.
  private pause(runtime: Runtime): void {
    if (runtime.timer) this.clearTimer(runtime.timer);
    runtime.timer = null;
    runtime.nextAt = null;
    runtime.pending = false;
    runtime.paused = runtime.config.intervalMinutes !== null;
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

  private async attempt(runtime: Runtime): Promise<void> {
    if (!this.runtimes.has(runtime.threadId) || runtime.config.intervalMinutes === null || runtime.delivering) return;
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
      const delivered = await this.deps.deliver(
        runtime.channel,
        runtime.threadId,
        runtime.config.message,
        runtime.config.intervalMinutes,
      );
      if (!delivered) throw new Error('message bus rejected heartbeat');
      runtime.pending = false;
      runtime.onBeat?.({
        threadId:        runtime.threadId,
        createdAt:       this.now(),
        intervalMinutes: runtime.config.intervalMinutes,
        message:         runtime.config.message,
      });
      // The beat just woke the graph; if it's already running, stay paused
      // until it stops rather than counting down over the top of it.
      if (runtime.busy) this.pause(runtime);
      else this.schedule(runtime);
    } catch (err) {
      console.warn(`[ChatHeartbeat] delivery failed for thread ${ runtime.threadId }:`, err);
      runtime.pending = true;
      this.schedule(runtime, BUSY_RETRY_MS);
    } finally {
      runtime.delivering = false;
      this.emitStatus(runtime);
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
      paused:          runtime.paused,
    };
  }

  private emitStatus(runtime: Runtime): ChatHeartbeatStatus {
    const status = this.toStatus(runtime);
    runtime.onStatus?.(status);
    return status;
  }
}
