// HeartbeatService.ts

import { startCaffeinate, stopCaffeinate, scheduleWake } from '../../main/SleepPreventionService';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

// ── Event History Types ──

export type HeartbeatEventType =
  | 'scheduler_started'
  | 'scheduler_check'
  | 'heartbeat_skipped'
  | 'heartbeat_triggered'
  | 'heartbeat_completed'
  | 'heartbeat_error'
  | 'heartbeat_already_running'
  | 'heartbeat_aborted'
  | 'sleep_prevention_started'
  | 'sleep_prevention_stopped'
  | 'wake_scheduled';

export interface HeartbeatEvent {
  ts:          number;
  type:        HeartbeatEventType;
  message:     string;
  durationMs?: number;
  error?:      string;
  meta?:       Record<string, unknown>;
}

export interface HeartbeatStatus {
  initialized:      boolean;
  isExecuting:      boolean;
  lastTriggerMs:    number;
  schedulerRunning: boolean;
  totalTriggers:    number;
  totalErrors:      number;
  totalSkips:       number;
  consecutiveFailures: number;
  uptimeMs:         number;
}

const MAX_EVENT_HISTORY = 200;

// Consecutive-failure escalation. Threshold uses === as a latch: one
// notification per outage, re-armed only by a successful cycle; while the
// outage persists we re-ping every RENOTIFY_EVERY-th failure.
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const CONSECUTIVE_FAILURE_RENOTIFY_EVERY = 25;

let heartbeatServiceInstance: HeartbeatService | null = null;

export function getHeartbeatService(): HeartbeatService {
  if (!heartbeatServiceInstance) {
    heartbeatServiceInstance = new HeartbeatService();
  }
  return heartbeatServiceInstance;
}

export class HeartbeatService {
  private initialized = false;
  private schedulerId:  ReturnType<typeof setInterval> | null = null;
  private alignTimerId: ReturnType<typeof setTimeout> | null = null;
  private isExecuting = false;
  private lastTriggerMs = 0; // simple in-memory last-run tracker

  // ── Circular event history buffer ──
  private eventBuffer: (HeartbeatEvent | null)[] = new Array(MAX_EVENT_HISTORY).fill(null);
  private eventHead = 0;   // next write position
  private eventCount = 0;  // total events written (for ordering)

  private totalTriggers = 0;
  private totalErrors = 0;
  private totalSkips = 0;
  // Failed cycles in a row (aborts and already-running skips don't count).
  // In-memory only: an outage is a run of failures within one process, and
  // the notification fires at cycle 3 — persistence across restarts would
  // only matter for outages shorter than the threshold.
  private consecutiveFailures = 0;
  private startedAtMs = 0;

  // ── Abort controller for in-flight heartbeat ──
  private activeAbort: AbortController | null = null;

  private executionStartedMs = 0;
  private suspendStartedMs = 0;

  // ── Standing sleep-prevention (continuous, not per-cycle) ──
  // The per-execution caffeinate (startCaffeinate('heartbeat') in
  // triggerHeartbeat) only spans a single cycle. Between cycles nothing held
  // the Mac awake, so an idle-sleep in the inter-cycle gap froze the 60s
  // scheduler timer — and scheduleWake() is a root-gated no-op, so nothing
  // woke it. The operator silently stopped standing until a manual wake.
  // Fix: hold caffeinate -i -s for the WHOLE enabled lifetime, transition-
  // guarded so we call start/stop once per toggle (not every minute).
  // Limits (documented, need root/pmset to fully solve): caffeinate -s only
  // asserts on AC power and does not defeat clamshell/lid-close sleep.
  private standingCaffeineHeld = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    console.log('[HeartbeatService] Initializing scheduler...');
    this.initialized = true;
    this.startedAtMs = Date.now();
    const persisted = Number(await SullaSettingsModel.get('heartbeatLastTriggerMs', 0)) || 0;
    if (persisted > 0) this.lastTriggerMs = persisted;
    this.recordEvent('scheduler_started', persisted
      ? `Heartbeat scheduler initialized (last run ${ new Date(persisted).toISOString() })`
      : 'Heartbeat scheduler initialized');
    this.startScheduler();
  }

  // ── Public status API ──

  getStatus(): HeartbeatStatus {
    return {
      initialized:      this.initialized,
      isExecuting:      this.isExecuting,
      lastTriggerMs:    this.lastTriggerMs,
      schedulerRunning: this.schedulerId !== null,
      totalTriggers:    this.totalTriggers,
      totalErrors:      this.totalErrors,
      totalSkips:       this.totalSkips,
      consecutiveFailures: this.consecutiveFailures,
      uptimeMs:         this.startedAtMs > 0 ? Date.now() - this.startedAtMs : 0,
    };
  }

  getHistory(limit = 50): HeartbeatEvent[] {
    const filled = Math.min(this.eventCount, MAX_EVENT_HISTORY);
    const result: HeartbeatEvent[] = [];

    // Read from oldest to newest
    const start = filled < MAX_EVENT_HISTORY ? 0 : this.eventHead;
    for (let i = 0; i < filled; i++) {
      const idx = (start + i) % MAX_EVENT_HISTORY;
      const evt = this.eventBuffer[idx];
      if (evt) result.push(evt);
    }

    // Return only the most recent `limit` entries
    return result.slice(-limit);
  }

  private recordEvent(type: HeartbeatEventType, message: string, extra?: Partial<HeartbeatEvent>): void {
    const event: HeartbeatEvent = { ts: Date.now(), type, message, ...extra };
    this.eventBuffer[this.eventHead] = event;
    this.eventHead = (this.eventHead + 1) % MAX_EVENT_HISTORY;
    this.eventCount++;
  }

  /**
   * Acquire the continuous standing-shift caffeinate hold. Idempotent: the
   * transition guard means we only spawn/log on the disabled→enabled edge, so
   * calling this every minute from the scheduler is safe.
   */
  private acquireStandingCaffeine(): void {
    if (this.standingCaffeineHeld) return;
    startCaffeinate('heartbeat-standing');
    this.standingCaffeineHeld = true;
    this.recordEvent('sleep_prevention_started', 'Standing caffeinate held — prevents inter-cycle idle sleep while heartbeat is enabled');
  }

  /** Release the standing-shift hold (heartbeat disabled or service destroyed). */
  private releaseStandingCaffeine(): void {
    if (!this.standingCaffeineHeld) return;
    stopCaffeinate('heartbeat-standing');
    this.standingCaffeineHeld = false;
    this.recordEvent('sleep_prevention_stopped', 'Standing caffeinate released — heartbeat disabled or service stopped');
  }

  private startScheduler(): void {
    if (this.schedulerId) return;

    // Align to next full minute
    const msToNextMinute = 60000 - (Date.now() % 60000);
    this.alignTimerId = setTimeout(() => {
      this.alignTimerId = null;
      if (!this.initialized) return; // destroyed before timer fired
      this.checkAndMaybeTrigger();
      this.schedulerId = setInterval(() => this.checkAndMaybeTrigger(), 60000);
    }, msToNextMinute);

    console.log('[HeartbeatService] Scheduler running — checks every minute on the minute');
  }

  private async checkAndMaybeTrigger(): Promise<void> {
    try {
      const enabled = await SullaSettingsModel.get('heartbeatEnabled', false);
      if (!enabled) {
        this.totalSkips++;
        this.recordEvent('heartbeat_skipped', 'Heartbeat disabled in settings');

        // Let the Mac sleep again once the operator is off-shift.
        this.releaseStandingCaffeine();

        // Abort any in-flight heartbeat when disabled
        if (this.isExecuting && this.activeAbort) {
          console.log('[HeartbeatService] Heartbeat disabled while executing — aborting');
          this.activeAbort.abort();
          this.recordEvent('heartbeat_aborted', 'In-flight heartbeat aborted due to disable toggle');
        }
        return;
      }

      // Enabled → keep the operator standing. Held continuously (through the
      // window gate below too) so that if the Mac would otherwise idle-sleep
      // during an out-of-window stretch, the scheduler timer survives and the
      // next in-window minute still fires. scheduleWake() can't do this (root).
      this.acquireStandingCaffeine();

      // ── Time-window gate ──
      // Users who only want autonomous runs during certain hours (e.g.
      // 9am–5pm weekdays) set heartbeatWindow. Format is permissive:
      //   { days: [1,2,3,4,5], startHour: 9, endHour: 17, tz: "America/..." }
      // Any of days / startHour / endHour may be omitted; omitted means
      // "no restriction on that axis." tz defaults to the system tz.
      const windowRaw = await SullaSettingsModel.get('heartbeatWindow', null);
      if (windowRaw) {
        const inside = isInsideWindow(windowRaw);
        if (!inside) {
          this.totalSkips++;
          this.recordEvent('heartbeat_skipped', 'Outside configured time-window');
          return;
        }
      }

      const delayMin = Math.max(1, await SullaSettingsModel.get('heartbeatDelayMinutes', 15));
      const delayMs = delayMin * 60_000;

      if (Date.now() - this.lastTriggerMs >= delayMs) {
        console.log(`[HeartbeatService] ⏰ Heartbeat due (${ delayMin } min) — triggering`);
        this.recordEvent('scheduler_check', `Heartbeat due (${ delayMin }min interval) — triggering`);
        await this.triggerHeartbeat();
        this.lastTriggerMs = Date.now();
        void SullaSettingsModel.set('heartbeatLastTriggerMs', this.lastTriggerMs, 'number');

        // Schedule a macOS wake event for the next heartbeat (only if >5 min away)
        if (delayMin > 5) {
          const nextHeartbeat = new Date(this.lastTriggerMs + delayMs);
          scheduleWake(nextHeartbeat);
          this.recordEvent('wake_scheduled', `Scheduled Mac wake for next heartbeat at ${ nextHeartbeat.toLocaleTimeString() }`);
        }
      } else {
        const remainingMs = delayMs - (Date.now() - this.lastTriggerMs);
        this.recordEvent('scheduler_check', `Next heartbeat in ${ Math.ceil(remainingMs / 60000) }min`);
      }
    } catch (err) {
      this.totalErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      this.recordEvent('heartbeat_error', `Scheduler check failed: ${ msg }`, { error: msg });
      console.error('[HeartbeatService] Scheduler check failed:', err);
    }
  }

  private async triggerHeartbeat(): Promise<void> {
    if (this.isExecuting) {
      console.log('[HeartbeatService] Already executing — skip');
      this.totalSkips++;
      this.recordEvent('heartbeat_already_running', 'Heartbeat already executing — skipped');
      return;
    }

    this.isExecuting = true;
    this.totalTriggers++;
    const triggerStart = Date.now();
    this.executionStartedMs = triggerStart;
    this.recordEvent('heartbeat_triggered', 'Heartbeat execution started');

    // Create abort controller for this execution
    this.activeAbort = new AbortController();
    const { signal } = this.activeAbort;

    // Prevent Mac from sleeping while the heartbeat agent works
    startCaffeinate('heartbeat');
    this.recordEvent('sleep_prevention_started', 'caffeinate acquired for heartbeat execution');

    try {
      // System prompt is now built by SystemPromptBuilder in HeartbeatNode.
      // The user message is just a timestamp trigger for the heartbeat cycle.
      const fullPrompt = this.buildHeartbeatPrompt('');

      console.log('[HeartbeatService] Dispatching to HeartbeatGraph via GraphRegistry');

      const { GraphRegistry } = await import('./GraphRegistry');
      const { graph, state } = await GraphRegistry.getOrCreateOverlordGraph('heartbeat', fullPrompt);

      // Reset for fresh run
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;
      (state.metadata as any).agent = undefined;
      (state.metadata as any).agentLoopCount = 0;
      (state.metadata as any).abortSignal = signal;

      // Inject the prompt as a fresh user message
      state.messages = [{
        role:     'user',
        content:  fullPrompt,
        metadata: { source: 'heartbeat' },
      }];

      // Check abort before executing
      if (signal.aborted) {
        this.recordEvent('heartbeat_aborted', 'Heartbeat aborted before graph execution');
        return;
      }

      await graph.execute(state, 'input_handler');
      this.consecutiveFailures = 0;
      const durationMs = Date.now() - triggerStart;
      const agentMeta = (state.metadata as any).agent || {};
      const status = agentMeta.status || 'unknown';
      const loopCount = (state.metadata as any).agentLoopCount || 0;
      this.recordEvent('heartbeat_completed', `Completed in ${ Math.round(durationMs / 1000) }s — ${ loopCount } cycles, status: ${ status }`, {
        durationMs,
        meta: { cycleCount: loopCount, status, focus: agentMeta.status_note || '' },
      });
      console.log('[HeartbeatService] Heartbeat graph execution completed');
    } catch (err) {
      if (signal.aborted) {
        const durationMs = Date.now() - triggerStart;
        this.recordEvent('heartbeat_aborted', `Heartbeat aborted after ${ Math.round(durationMs / 1000) }s`, { durationMs });
        console.log('[HeartbeatService] Heartbeat execution aborted');
      } else {
        this.totalErrors++;
        this.consecutiveFailures++;
        const durationMs = Date.now() - triggerStart;
        const msg = err instanceof Error ? err.message : String(err);
        this.recordEvent('heartbeat_error', `Execution failed after ${ Math.round(durationMs / 1000) }s: ${ msg }`, { durationMs, error: msg });
        console.error('[HeartbeatService] Heartbeat execution failed:', err);
        await this.escalateIfFailuresPersist(msg);
      }
    } finally {
      stopCaffeinate('heartbeat');
      this.recordEvent('sleep_prevention_stopped', 'caffeinate released after heartbeat execution');
      this.activeAbort = null;
      this.isExecuting = false;
      this.executionStartedMs = 0;
    }
  }

  /**
   * Escalate a run of dead cycles to the human. The 2026-08-14 provider
   * outage produced ~151 consecutive sub-second cycle failures over 43 hours
   * with zero notification — the routine digest watches workflow routines,
   * not this service, so nothing surfaced it. Delivery is the same
   * Electron-native path notify_user uses (no LLM provider in the loop),
   * because this must work precisely when every provider is down.
   */
  private async escalateIfFailuresPersist(lastError: string): Promise<void> {
    const n = this.consecutiveFailures;
    const firstFire = n === CONSECUTIVE_FAILURE_THRESHOLD;
    const rePing = n > CONSECUTIVE_FAILURE_THRESHOLD && n % CONSECUTIVE_FAILURE_RENOTIFY_EVERY === 0;
    if (!firstFire && !rePing) return;

    const title = 'Heartbeat operator is down';
    const message = `${ n } consecutive heartbeat cycle failures — last error: ${ lastError }`;
    try {
      const { getChromeApi } = await import('@pkg/main/chromeApi');
      await getChromeApi().notifications.create('heartbeat-consecutive-failures', { title, message });
      this.recordEvent('heartbeat_error', `${ n } consecutive cycle failures — user notified`, { error: lastError, meta: { consecutiveFailures: n } });
    } catch (notifyErr) {
      // A broken notification path must not mask the original cycle error.
      console.error('[HeartbeatService] Failure-streak notification failed:', notifyErr);
      this.recordEvent('heartbeat_error', `${ n } consecutive cycle failures — notification delivery failed`, { error: String(notifyErr), meta: { consecutiveFailures: n } });
    }
  }

  private buildHeartbeatPrompt(base: string): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday:  'long',
      year:     'numeric',
      month:    'long',
      day:      'numeric',
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   true,
    });

    const directive = `This is your scheduled autonomous work time.

Current time: ${ timeStr }
Timezone: ${ tz }

Your active projects and goals have been loaded into your recall context. Review them and take meaningful action on the highest-priority next step. Work autonomously until you make concrete progress, then summarize what you accomplished.${ base ? `\n\n${ base }` : '' }`;

    return directive;
  }

  /** Call from UI after settings change to force immediate check */
  async forceCheck(): Promise<void> {
    if (this.initialized) await this.checkAndMaybeTrigger();
  }

  /** powerMonitor suspend — remember when the machine went down. */
  handleSuspend(): void {
    if (!this.initialized) return;
    this.suspendStartedMs = Date.now();
    this.recordEvent('scheduler_check', 'System suspending');
  }

  /**
   * powerMonitor resume — the 60s setInterval freezes across sleep and is
   * unreliable after thaw. Relay already reconnects here; the standing shift
   * must too. A long sleep kills in-flight LLM sockets, so abort those and
   * let the delayed check start a fresh cycle.
   */
  async handleResume(): Promise<void> {
    if (!this.initialized) return;

    // Prefer the suspend stamp. macOS sometimes delivers resume without
    // suspend (clamshell, some lid events); fall back to how long the
    // current run has been latched so isExecuting cannot stay stuck.
    const now = Date.now();
    const stampedMs = this.suspendStartedMs > 0 ? now - this.suspendStartedMs : 0;
    const inferredMs = (this.isExecuting && this.executionStartedMs > 0)
      ? now - this.executionStartedMs
      : 0;
    const sleptMs = Math.max(stampedMs, inferredMs);
    const inferred = stampedMs === 0 && inferredMs > 0;
    this.suspendStartedMs = 0;
    const sleptMin = Math.round(sleptMs / 60000);
    this.recordEvent('scheduler_check', sleptMs > 0
      ? `System resumed after ${ sleptMin }min ${ inferred ? 'inferred ' : '' }sleep — forcing heartbeat check`
      : 'System resumed — forcing heartbeat check');

    const LONG_SLEEP_MS = 120_000;
    if (this.isExecuting && sleptMs > LONG_SLEEP_MS && this.activeAbort) {
      console.log(`[HeartbeatService] Aborting in-flight heartbeat after ${ sleptMin }min sleep`);
      this.activeAbort.abort();
      this.recordEvent('heartbeat_aborted', `In-flight heartbeat aborted after ${ sleptMin }min sleep`);
      setTimeout(() => {
        void this.checkAndMaybeTrigger();
      }, 2000);
      return;
    }

    await this.checkAndMaybeTrigger();
  }

  destroy(): void {
    this.initialized = false;
    // Drop the standing sleep-prevention hold so we don't leak a caffeinate
    // process across a service teardown/reinit.
    this.releaseStandingCaffeine();
    // Abort any in-flight execution
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
    if (this.alignTimerId) {
      clearTimeout(this.alignTimerId);
      this.alignTimerId = null;
    }
    if (this.schedulerId) {
      clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
  }
}

/**
 * Decide whether the current wall-clock time is inside the user-configured
 * heartbeat window. Accepts the raw settings value (may be a JSON string
 * from SullaSettingsModel or an already-parsed object).
 *
 * Shape:
 *   { days?: number[], startHour?: number, endHour?: number, tz?: string }
 * - days: 0–6 (Sun–Sat). Omit = any day.
 * - startHour / endHour: 0–24. If start < end, window is same-day. If start
 *   > end, window wraps midnight (e.g. 22→6). Omit both = any hour.
 * - tz: IANA tz. Defaults to system tz.
 *
 * Permissive on malformed input — returns true so a bad config doesn't
 * silently lock the heartbeat off forever.
 */
function isInsideWindow(raw: unknown): boolean {
  try {
    let cfg: any = raw;
    if (typeof cfg === 'string') cfg = JSON.parse(cfg);
    if (!cfg || typeof cfg !== 'object') return true;

    const tz = typeof cfg.tz === 'string' && cfg.tz.length > 0 ? cfg.tz : undefined;
    const now = tzPartsOf(new Date(), tz);

    if (Array.isArray(cfg.days) && cfg.days.length > 0) {
      if (!cfg.days.includes(now.day)) return false;
    }

    const start = typeof cfg.startHour === 'number' ? cfg.startHour : null;
    const end   = typeof cfg.endHour === 'number' ? cfg.endHour : null;
    if (start !== null && end !== null) {
      const hr = now.hour;
      if (start <= end) {
        // Same-day: include start..end-1
        if (hr < start || hr >= end) return false;
      } else {
        // Wraps midnight: e.g. 22..6 = 22, 23, 0..5
        if (hr < start && hr >= end) return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

function tzPartsOf(d: Date, tz?: string): { hour: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday:  'short',
    hour:     '2-digit',
    hour12:   false,
  });
  const parts = fmt.formatToParts(d);
  const hourStr = parts.find(p => p.type === 'hour')?.value ?? String(d.getHours());
  const wk      = parts.find(p => p.type === 'weekday')?.value ?? '';
  const DAYMAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour: Math.max(0, Math.min(23, parseInt(hourStr, 10) || 0)),
    day:  DAYMAP[wk] ?? d.getDay(),
  };
}
