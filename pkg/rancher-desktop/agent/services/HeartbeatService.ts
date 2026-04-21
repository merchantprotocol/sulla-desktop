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
  uptimeMs:         number;
}

const MAX_EVENT_HISTORY = 200;

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
  private startedAtMs = 0;

  // ── Abort controller for in-flight heartbeat ──
  private activeAbort: AbortController | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    console.log('[HeartbeatService] Initializing scheduler...');
    this.initialized = true;
    this.startedAtMs = Date.now();
    this.recordEvent('scheduler_started', 'Heartbeat scheduler initialized');
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

        // Abort any in-flight heartbeat when disabled
        if (this.isExecuting && this.activeAbort) {
          console.log('[HeartbeatService] Heartbeat disabled while executing — aborting');
          this.activeAbort.abort();
          this.recordEvent('heartbeat_aborted', 'In-flight heartbeat aborted due to disable toggle');
        }
        return;
      }

      const delayMin = Math.max(1, await SullaSettingsModel.get('heartbeatDelayMinutes', 15));
      const delayMs = delayMin * 60_000;

      if (Date.now() - this.lastTriggerMs >= delayMs) {
        console.log(`[HeartbeatService] ⏰ Heartbeat due (${ delayMin } min) — triggering`);
        this.recordEvent('scheduler_check', `Heartbeat due (${ delayMin }min interval) — triggering`);
        await this.triggerHeartbeat();
        this.lastTriggerMs = Date.now();

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
        const durationMs = Date.now() - triggerStart;
        const msg = err instanceof Error ? err.message : String(err);
        this.recordEvent('heartbeat_error', `Execution failed after ${ Math.round(durationMs / 1000) }s: ${ msg }`, { durationMs, error: msg });
        console.error('[HeartbeatService] Heartbeat execution failed:', err);
      }
    } finally {
      stopCaffeinate('heartbeat');
      this.recordEvent('sleep_prevention_stopped', 'caffeinate released after heartbeat execution');
      this.activeAbort = null;
      this.isExecuting = false;
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

  destroy(): void {
    this.initialized = false;
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
