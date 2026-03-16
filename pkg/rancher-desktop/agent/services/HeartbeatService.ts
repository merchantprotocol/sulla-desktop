// HeartbeatService.ts

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { startCaffeinate, stopCaffeinate, scheduleWake } from '../../main/SleepPreventionService';

// ── Event History Types ──

export type HeartbeatEventType =
  | 'scheduler_started'
  | 'scheduler_check'
  | 'heartbeat_skipped'
  | 'heartbeat_triggered'
  | 'heartbeat_completed'
  | 'heartbeat_error'
  | 'heartbeat_already_running'
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
  private schedulerId: ReturnType<typeof setInterval> | null = null;
  private isExecuting = false;
  private lastTriggerMs = 0; // simple in-memory last-run tracker

  // ── Event history ring buffer ──
  private eventHistory: HeartbeatEvent[] = [];
  private totalTriggers = 0;
  private totalErrors = 0;
  private totalSkips = 0;
  private startedAtMs = 0;

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
    return this.eventHistory.slice(-limit);
  }

  private recordEvent(type: HeartbeatEventType, message: string, extra?: Partial<HeartbeatEvent>): void {
    const event: HeartbeatEvent = { ts: Date.now(), type, message, ...extra };
    this.eventHistory.push(event);
    if (this.eventHistory.length > MAX_EVENT_HISTORY) {
      this.eventHistory = this.eventHistory.slice(-MAX_EVENT_HISTORY);
    }
  }

  private startScheduler(): void {
    if (this.schedulerId) return;

    // Align to next full minute
    const msToNextMinute = 60000 - (Date.now() % 60000);
    setTimeout(() => {
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
        return;
      }

      const delayMin = Math.max(1, await SullaSettingsModel.get('heartbeatDelayMinutes', 30));
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

    // Prevent Mac from sleeping while the heartbeat agent works
    startCaffeinate('heartbeat');
    this.recordEvent('sleep_prevention_started', 'caffeinate acquired for heartbeat execution');

    try {
      const basePrompt = await SullaSettingsModel.get('heartbeatPrompt', '');
      const fullPrompt = this.buildHeartbeatPrompt(basePrompt);

      console.log('[HeartbeatService] Dispatching to HeartbeatGraph via GraphRegistry');

      const { GraphRegistry } = await import('./GraphRegistry');
      const { graph, state } = await GraphRegistry.getOrCreateOverlordGraph('heartbeat', fullPrompt);

      // Reset for fresh run
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;
      (state.metadata as any).heartbeatCycleCount = 0;
      (state.metadata as any).heartbeatStatus = 'idle';

      // Inject the prompt as a fresh user message
      state.messages = [{
        role:     'user',
        content:  fullPrompt,
        metadata: { source: 'heartbeat' },
      }];

      await graph.execute(state, 'input_handler');
      const durationMs = Date.now() - triggerStart;
      const cycleCount = (state.metadata as any).heartbeatCycleCount || 0;
      const status = (state.metadata as any).heartbeatStatus || 'unknown';
      this.recordEvent('heartbeat_completed', `Completed in ${ Math.round(durationMs / 1000) }s — ${ cycleCount } cycles, status: ${ status }`, {
        durationMs,
        meta: { cycleCount, status, focus: (state.metadata as any).currentFocus || '' },
      });
      console.log('[HeartbeatService] Heartbeat graph execution completed');
    } catch (err) {
      this.totalErrors++;
      const durationMs = Date.now() - triggerStart;
      const msg = err instanceof Error ? err.message : String(err);
      this.recordEvent('heartbeat_error', `Execution failed after ${ Math.round(durationMs / 1000) }s: ${ msg }`, { durationMs, error: msg });
      console.error('[HeartbeatService] Heartbeat execution failed:', err);
    } finally {
      stopCaffeinate('heartbeat');
      this.recordEvent('sleep_prevention_stopped', 'caffeinate released after heartbeat execution');
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

    return `\nCurrent time: ${ timeStr }\nTimezone: ${ tz }\n\n${ base }`;
  }

  /** Call from UI after settings change to force immediate check */
  async forceCheck(): Promise<void> {
    if (this.initialized) await this.checkAndMaybeTrigger();
  }

  destroy(): void {
    if (this.schedulerId) {
      clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
    this.initialized = false;
  }
}
