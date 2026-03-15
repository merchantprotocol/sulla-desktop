// HumanHeartbeatBridge.ts
// Redis-backed human presence state store. Tracks what the human is currently
// viewing/doing so agents can be aware of human availability and activity.

import { redisClient } from '../database/RedisClient';

// ============================================================================
// TYPES
// ============================================================================

export interface HumanPresence {
  available:       boolean;
  lastSeen:        number;
  currentView:     string;
  currentActivity: string;
  activeChannel:   string;
  idleMinutes:     number;
  metadata?:       Record<string, unknown>;
}

// ============================================================================
// REDIS KEY CONSTANTS
// ============================================================================

const HUMAN_PRESENCE_HASH = 'sulla:bridge:human_presence';

// ============================================================================
// SERVICE
// ============================================================================

let bridgeInstance: HumanHeartbeatBridge | null = null;

export function getHumanHeartbeatBridge(): HumanHeartbeatBridge {
  if (!bridgeInstance) {
    bridgeInstance = new HumanHeartbeatBridge();
  }
  return bridgeInstance;
}

export class HumanHeartbeatBridge {
  // ------------------------------------------------------------------
  // HUMAN PRESENCE
  // ------------------------------------------------------------------

  async updatePresence(presence: Partial<HumanPresence>): Promise<void> {
    const fields: [string, string][] = [];

    if (presence.available !== undefined) fields.push(['available', String(presence.available)]);
    if (presence.currentView !== undefined) fields.push(['currentView', presence.currentView]);
    if (presence.currentActivity !== undefined) fields.push(['currentActivity', presence.currentActivity]);
    if (presence.activeChannel !== undefined) fields.push(['activeChannel', presence.activeChannel]);
    if (presence.idleMinutes !== undefined) fields.push(['idleMinutes', String(presence.idleMinutes)]);
    if (presence.metadata !== undefined) fields.push(['metadata', JSON.stringify(presence.metadata)]);

    // Always stamp lastSeen
    fields.push(['lastSeen', String(Date.now())]);

    for (const [field, value] of fields) {
      await redisClient.hset(HUMAN_PRESENCE_HASH, field, value);
    }
  }

  async getPresence(): Promise<HumanPresence> {
    const raw = await redisClient.hgetall(HUMAN_PRESENCE_HASH);

    const lastSeen = parseInt(raw.lastSeen || '0', 10);
    const idleMinutes = lastSeen > 0
      ? Math.floor((Date.now() - lastSeen) / 60000)
      : 999;

    return {
      available:       raw.available === 'true',
      lastSeen,
      currentView:     raw.currentView || 'unknown',
      currentActivity: raw.currentActivity || 'unknown',
      activeChannel:   raw.activeChannel || '',
      idleMinutes,
      metadata:        raw.metadata ? JSON.parse(raw.metadata) : undefined,
    };
  }

  async getPresenceSummary(): Promise<string> {
    const p = await this.getPresence();

    if (!p.lastSeen || p.idleMinutes > 60) {
      return `**Jonathon (human):** Offline / Away (last seen ${ p.idleMinutes }m ago)`;
    }

    const parts = [
      `**Jonathon (human):** ${ p.available ? 'Available' : 'Busy' }`,
      `idle ${ p.idleMinutes }m`,
      `viewing "${ p.currentView }"`,
      `activity: ${ p.currentActivity }`,
    ];

    if (p.activeChannel) {
      parts.push(`on channel \`${ p.activeChannel }\``);
    }

    return parts.join(' · ');
  }
}
