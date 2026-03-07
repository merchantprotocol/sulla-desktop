// HumanPresenceTracker.ts
// Frontend-side service that periodically writes human presence state
// to Redis via HumanHeartbeatBridge. Tracks user activity, idle time,
// current view, and which channel the human is on.

import { getHumanHeartbeatBridge } from './HumanHeartbeatBridge';

let trackerInstance: HumanPresenceTracker | null = null;

export function getHumanPresenceTracker(): HumanPresenceTracker {
  if (!trackerInstance) {
    trackerInstance = new HumanPresenceTracker();
  }
  return trackerInstance;
}

export class HumanPresenceTracker {
  private presenceInterval: ReturnType<typeof setInterval> | null = null;
  private lastActivityMs = Date.now();
  private currentView = 'Agent Chat';
  private currentActivity = 'active';
  private activeChannel = 'sulla-desktop';
  private destroyed = false;

  private readonly PRESENCE_INTERVAL_MS = 30_000;   // update presence every 30s
  private readonly IDLE_THRESHOLD_MS = 300_000;      // 5 minutes = idle

  start(): void {
    if (this.presenceInterval || this.destroyed) return;

    // Write presence immediately
    this.writePresence();

    // Start periodic presence writer
    this.presenceInterval = setInterval(() => this.writePresence(), this.PRESENCE_INTERVAL_MS);

    console.log('[HumanPresenceTracker] Started (presence every 30s)');
  }

  stop(): void {
    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
      this.presenceInterval = null;
    }
    this.destroyed = true;
    console.log('[HumanPresenceTracker] Stopped');
  }

  // ------------------------------------------------------------------
  // PUBLIC API — called by Vue components to update presence state
  // ------------------------------------------------------------------

  recordActivity(): void {
    this.lastActivityMs = Date.now();
    this.currentActivity = 'active';
  }

  setCurrentView(view: string): void {
    this.currentView = view;
    this.recordActivity();
  }

  setCurrentActivity(activity: string): void {
    this.currentActivity = activity;
    this.recordActivity();
  }

  setActiveChannel(channel: string): void {
    this.activeChannel = channel;
    this.recordActivity();
  }

  // ------------------------------------------------------------------
  // INTERNALS
  // ------------------------------------------------------------------

  private async writePresence(): Promise<void> {
    try {
      const bridge = getHumanHeartbeatBridge();
      const idleMs = Date.now() - this.lastActivityMs;
      const isIdle = idleMs > this.IDLE_THRESHOLD_MS;

      await bridge.updatePresence({
        available: !isIdle,
        currentView: this.currentView,
        currentActivity: isIdle ? 'idle' : this.currentActivity,
        activeChannel: this.activeChannel,
        idleMinutes: Math.floor(idleMs / 60000),
      });
    } catch (err) {
      // Silently fail — Redis may not be ready yet
      console.debug('[HumanPresenceTracker] Presence write failed:', err);
    }
  }
}
