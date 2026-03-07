// HeartbeatService.ts

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

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

  async initialize(): Promise<void> {
    if (this.initialized) return;
    console.log('[HeartbeatService] Initializing scheduler...');
    this.initialized = true;
    this.startScheduler();
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
      console.log(`[HeartbeatService] heartbeatEnabled = ${JSON.stringify(enabled)} (type: ${typeof enabled})`);
      if (!enabled) return;

      const delayMin = Math.max(1, await SullaSettingsModel.get('heartbeatDelayMinutes', 30));
      const delayMs  = delayMin * 60_000;

      if (Date.now() - this.lastTriggerMs >= delayMs) {
        console.log(`[HeartbeatService] ⏰ Heartbeat due (${delayMin} min) — triggering`);
        await this.triggerHeartbeat();
        this.lastTriggerMs = Date.now();
      }
    } catch (err) {
      console.error('[HeartbeatService] Scheduler check failed:', err);
    }
  }

  private async triggerHeartbeat(): Promise<void> {
    if (this.isExecuting) {
      console.log('[HeartbeatService] Already executing — skip');
      return;
    }

    this.isExecuting = true;

    try {
      const basePrompt  = await SullaSettingsModel.get('heartbeatPrompt', '');
      const providerSetting = await SullaSettingsModel.get('heartbeatProvider', 'default');

      const fullPrompt = this.buildHeartbeatPrompt(basePrompt);

      console.log(`[HeartbeatService] Building heartbeat prompt (provider=${providerSetting})`);

      const { getWorkflowRegistry } = await import('../workflow/WorkflowRegistry');
      const registry = getWorkflowRegistry();

      console.log('[HeartbeatService] Dispatching to WorkflowRegistry — triggerType="heartbeat", originChannel="heartbeat"');

      const result = await registry.dispatch({
        triggerType: 'heartbeat',
        message: fullPrompt,
        originChannel: 'heartbeat',
      });

      if (result) {
        console.log(`[HeartbeatService] Heartbeat dispatched to workflow "${result.workflowName}" (${result.workflowId})`);
      } else {
        console.log('[HeartbeatService] No heartbeat workflow matched — no action taken');
      }
    } catch (err) {
      console.error('[HeartbeatService] Heartbeat execution failed:', err);
    } finally {
      this.isExecuting = false;
    }
  }

  private buildHeartbeatPrompt(base: string): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    return `\nCurrent time: ${timeStr}\nTimezone: ${tz}\n\n${base}`;
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