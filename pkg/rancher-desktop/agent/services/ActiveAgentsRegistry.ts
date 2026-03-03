// ActiveAgentsRegistry.ts
// Redis-backed registry of all active agents and the channels they run on.
// Every agent registers itself when it starts and deregisters when it stops.
// The human is also tracked here (via HumanPresenceTracker).
// Any agent can read this registry to know who's running where.

import { redisClient } from '../database/RedisClient';

// ============================================================================
// TYPES
// ============================================================================

export interface ActiveAgent {
  agentId: string;
  name: string;
  role: string;
  channel: string;
  type: 'heartbeat' | 'frontend' | 'agent' | 'human';
  status: 'running' | 'idle' | 'offline';
  startedAt: number;
  lastActiveAt: number;
  description: string;
  statusNote?: string;
}

// ============================================================================
// REDIS KEY
// ============================================================================

const REGISTRY_HASH = 'sulla:active_agents';

// ============================================================================
// SERVICE
// ============================================================================

let registryInstance: ActiveAgentsRegistry | null = null;

export function getActiveAgentsRegistry(): ActiveAgentsRegistry {
  if (!registryInstance) {
    registryInstance = new ActiveAgentsRegistry();
  }
  return registryInstance;
}

export class ActiveAgentsRegistry {

  private normalizeStatusNote(note: string): string {
    return String(note || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
  }

  async register(agent: ActiveAgent): Promise<void> {
    await redisClient.hset(REGISTRY_HASH, agent.agentId, JSON.stringify(agent));
  }

  async deregister(agentId: string): Promise<void> {
    const client = redisClient.getClient();
    await client.hdel(REGISTRY_HASH, agentId);
  }

  async updateStatus(agentId: string, status: ActiveAgent['status']): Promise<void> {
    const existing = await this.getAgent(agentId);
    if (!existing) return;
    existing.status = status;
    existing.lastActiveAt = Date.now();
    await redisClient.hset(REGISTRY_HASH, agentId, JSON.stringify(existing));
  }

  async heartbeat(agentId: string): Promise<void> {
    const existing = await this.getAgent(agentId);
    if (!existing) return;
    existing.lastActiveAt = Date.now();
    await redisClient.hset(REGISTRY_HASH, agentId, JSON.stringify(existing));
  }

  async updateStatusNote(agentId: string, statusNote: string): Promise<void> {
    const existing = await this.getAgent(agentId);
    if (!existing) return;

    const normalized = this.normalizeStatusNote(statusNote);
    if (!normalized) return;

    existing.statusNote = normalized;
    existing.lastActiveAt = Date.now();
    await redisClient.hset(REGISTRY_HASH, agentId, JSON.stringify(existing));
  }

  async updateStatusNoteByChannel(channel: string, statusNote: string): Promise<void> {
    const agent = await this.getAgentOnChannel(channel);
    if (!agent) return;
    await this.updateStatusNote(agent.agentId, statusNote);
  }

  async getAgent(agentId: string): Promise<ActiveAgent | null> {
    const raw = await redisClient.hget(REGISTRY_HASH, agentId);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getAllAgents(): Promise<ActiveAgent[]> {
    const raw = await redisClient.hgetall(REGISTRY_HASH);
    const agents: ActiveAgent[] = [];
    for (const value of Object.values(raw)) {
      try {
        agents.push(JSON.parse(value));
      } catch {
        // skip malformed
      }
    }
    return agents;
  }

  async getChannelForAgent(agentId: string): Promise<string | null> {
    const agent = await this.getAgent(agentId);
    return agent?.channel || null;
  }

  async getAgentOnChannel(channel: string): Promise<ActiveAgent | null> {
    const agents = await this.getAllAgents();
    return agents.find(a => a.channel === channel) || null;
  }

  // ------------------------------------------------------------------
  // CONTEXT BUILDER — produces the environmental context block
  // ------------------------------------------------------------------

  async buildContextBlock(): Promise<string> {
    const agents = await this.getAllAgents();

    if (agents.length === 0) {
      return `## Active Agents & Channels\nNo agents currently registered.`;
    }

    // Also pull human presence summary
    let humanLine = '';
    try {
      const { getHumanHeartbeatBridge } = await import('./HumanHeartbeatBridge');
      const bridge = getHumanHeartbeatBridge();
      humanLine = await bridge.getPresenceSummary();
    } catch {
      humanLine = '**Jonathon (human):** presence unknown';
    }

    const lines = agents
      .filter(a => a.type !== 'human')
      .map(a => {
        const age = Math.floor((Date.now() - a.lastActiveAt) / 60000);
        const name = a.name || a.agentId;
        const role = a.role || a.type;
        const currentWork = a.statusNote || 'idle';
        return `- **${name}** (${role}) · channel: \`${a.channel}\` · ${a.status} · currently: ${currentWork} · last active ${age}m ago`;
      });

    const parts = [
      `## Inter-Agent Communication`,
      ``,
      `You are part of an agent network. Here are all active agents (pulled from Redis):`,
      ``,
      humanLine,
      ``,
      ...lines,
      ``,
      `To message another agent, use the **send_channel_message** tool with the target channel name, your \`sender_id\`, and your \`sender_channel\`.`,
      ``,
      `**Critical rules:**`,
      `- \`send_channel_message\` is **fire-and-forget**. After sending, continue your work normally.`,
      `- Do NOT poll, search Redis, or look for a reply. If the receiving agent responds, their reply will arrive on your channel as an incoming message automatically.`,
      `- There is no inbox to check. There is no message thread in Redis. Do not go looking for one.`,
      `- If no reply comes, the agent either hasn't responded yet or chose not to. You can try again or move on.`,
    ];

    return parts.join('\n');
  }
}
