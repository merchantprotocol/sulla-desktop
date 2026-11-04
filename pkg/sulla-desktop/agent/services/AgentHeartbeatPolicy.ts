// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentDefinition, AgentHeartbeatConfig } from '../database/models/AgentDefinitionModel';

export type { AgentHeartbeatConfig } from '../database/models/AgentDefinitionModel';

export interface HeartbeatDecision {
  allowed: boolean;
  intervalMinutes: number;
  reason: string;
}

export interface AgentDefinitionLookup {
  get(id: string): Promise<AgentDefinition | null>;
  findBySlug(slug: string): Promise<AgentDefinition | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LEAD_DEFAULTS: AgentHeartbeatConfig = { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 1440 };

/**
 * Agent-side heartbeat policy. Visibility is deliberately not part of this
 * decision: chat/set_heartbeat callers provide an agent identity only.
 * The primary persona (sulla-desktop/sulla) uses lead defaults.
 */
export class AgentHeartbeatPolicy {
  constructor(private readonly definitions: AgentDefinitionLookup) {}

  async decide(agentId: string, requestedIntervalMinutes?: number): Promise<HeartbeatDecision> {
    if (requestedIntervalMinutes === 0) return { allowed: true, intervalMinutes: 0, reason: 'Heartbeats are turned off.' };
    const definition = await this.resolve(agentId);
    if (!definition) {
      if (agentId === 'sulla' || agentId === 'sulla-desktop') return this.evaluate(agentId, LEAD_DEFAULTS, requestedIntervalMinutes);
      return this.denied(agentId, requestedIntervalMinutes, `Agent definition not found for ${ agentId }.`);
    }
    const raw = definition.config?.heartbeat;
    if (!isRecord(raw)) {
      return this.denied(definition.slug, requestedIntervalMinutes, `Heartbeats are not allowed for agent ${ definition.slug }: set config.heartbeat.allowed = true in its agent definition.`);
    }
    const validated = AgentHeartbeatPolicy.validateConfig(raw);
    if (!validated.config) return this.denied(definition.slug, requestedIntervalMinutes, `Invalid heartbeat configuration: ${ validated.field }.`);
    return this.evaluate(definition.slug, validated.config, requestedIntervalMinutes);
  }

  private async resolve(agentId: string): Promise<AgentDefinition | null> {
    const bySlug = await this.definitions.findBySlug(agentId);
    return bySlug ?? await this.definitions.get(agentId);
  }

  static validateConfig(raw: Record<string, unknown>): { config: AgentHeartbeatConfig | null; field: string } {
    const fields = ['allowed', 'defaultIntervalMinutes', 'minIntervalMinutes', 'maxIntervalMinutes'] as const;
    if (typeof raw.allowed !== 'boolean') return { config: null, field: 'config.heartbeat.allowed' };
    for (const field of fields.slice(1)) {
      if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field]) || raw[field] <= 0 || raw[field] > 1440) {
        return { config: null, field: `config.heartbeat.${ field }` };
      }
    }
    const config = raw as unknown as AgentHeartbeatConfig;
    if (config.minIntervalMinutes > config.maxIntervalMinutes) return { config: null, field: 'config.heartbeat.minIntervalMinutes/maxIntervalMinutes' };
    if (config.defaultIntervalMinutes < config.minIntervalMinutes || config.defaultIntervalMinutes > config.maxIntervalMinutes) return { config: null, field: 'config.heartbeat.defaultIntervalMinutes' };
    return { config, field: '' };
  }

  private evaluate(slug: string, config: AgentHeartbeatConfig, requested?: number): HeartbeatDecision {
    const interval = requested === undefined ? config.defaultIntervalMinutes : requested;
    if (!Number.isFinite(interval) || interval < config.minIntervalMinutes || interval > config.maxIntervalMinutes) {
      return this.denied(slug, interval, `Heartbeat interval for agent ${ slug } must be between ${ config.minIntervalMinutes} and ${ config.maxIntervalMinutes} minutes.`);
    }
    if (!config.allowed) return this.denied(slug, interval, `Heartbeats are not allowed for agent ${ slug }: set config.heartbeat.allowed = true in its agent definition.`);
    return { allowed: true, intervalMinutes: interval, reason: `Heartbeat interval accepted for agent ${ slug }.` };
  }

  private denied(slug: string, interval: number | undefined, reason: string): HeartbeatDecision {
    return { allowed: false, intervalMinutes: interval ?? 0, reason };
  }
}
