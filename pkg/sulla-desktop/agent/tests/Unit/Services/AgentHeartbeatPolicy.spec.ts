// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { AgentHeartbeatPolicy } from '../../../services/AgentHeartbeatPolicy';

class InMemoryDefinitions {
  constructor(private readonly rows: Record<string, any>) {}
  set(slug: string, definition: any) { this.rows[slug] = definition; }
  async get(id: string) { return this.rows[id] ?? null; }
  async findBySlug(slug: string) { return this.rows[slug] ?? null; }
}

const lead = { id: 'lead-id', slug: 'lead', config: { heartbeat: { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 10 } } };
const worker = { id: 'worker-id', slug: 'worker', config: { heartbeat: { allowed: false, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 1440 } } };

describe('AgentHeartbeatPolicy', () => {
  it('allows configured agents, uses defaults, and refuses out-of-range values', async () => {
    const policy = new AgentHeartbeatPolicy(new InMemoryDefinitions({ lead }));
    await expect(policy.decide('lead')).resolves.toMatchObject({ allowed: true, intervalMinutes: 5 });
    await expect(policy.decide('lead', 11)).resolves.toMatchObject({ allowed: false });
  });

  it('denies workers and malformed configuration without throwing', async () => {
    const policy = new AgentHeartbeatPolicy(new InMemoryDefinitions({ worker, bad: { id: 'bad', slug: 'bad', config: { heartbeat: { allowed: true, minIntervalMinutes: 8, maxIntervalMinutes: 2, defaultIntervalMinutes: 5 } } } }));
    await expect(policy.decide('worker')).resolves.toMatchObject({ allowed: false });
    await expect(policy.decide('worker')).resolves.toMatchObject({ reason: expect.stringContaining('config.heartbeat.allowed') });
    await expect(policy.decide('bad')).resolves.toMatchObject({ allowed: false });
    const invalid = new AgentHeartbeatPolicy(new InMemoryDefinitions({ invalid: { id: 'invalid-id', slug: 'invalid', config: { heartbeat: { allowed: true, defaultIntervalMinutes: -1, minIntervalMinutes: 1, maxIntervalMinutes: 1440 } } } }));
    await expect(invalid.decide('invalid')).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    ['string', { allowed: true, defaultIntervalMinutes: '5', minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['null', { allowed: true, defaultIntervalMinutes: null, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['NaN', { allowed: true, defaultIntervalMinutes: Number.NaN, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['Infinity', { allowed: true, defaultIntervalMinutes: Number.POSITIVE_INFINITY, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['negative', { allowed: true, defaultIntervalMinutes: -1, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['zero', { allowed: true, defaultIntervalMinutes: 0, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['huge', { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 1441 }],
    ['missing key', { allowed: true, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['min greater than max', { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 8, maxIntervalMinutes: 2 }],
    ['default outside the configured min/max range', { allowed: true, defaultIntervalMinutes: 15, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['allowed is a string, not a boolean', { allowed: 'true', defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
    ['allowed missing entirely', { defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 10 }],
  ])('refuses malformed config.heartbeat: %s', async(_label, heartbeat) => {
    // risk: malformed persisted policy bypasses heartbeat governance
    const policy = new AgentHeartbeatPolicy(new InMemoryDefinitions({ bad: { id: 'bad-id', slug: 'bad', config: { heartbeat } } }));
    await expect(policy.decide('bad')).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('config.heartbeat'),
    });
  });

  it('names the specific out-of-range field in the refusal reason', async () => {
    // risk: a vague error leaves a human unable to find the bad field in the agent definition
    const policy = new AgentHeartbeatPolicy(new InMemoryDefinitions({
      bad: { id: 'bad-id', slug: 'bad', config: { heartbeat: { allowed: true, defaultIntervalMinutes: 15, minIntervalMinutes: 1, maxIntervalMinutes: 10 } } },
    }));
    await expect(policy.decide('bad')).resolves.toMatchObject({
      reason: expect.stringContaining('config.heartbeat.defaultIntervalMinutes'),
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1441])('refuses invalid requested interval %s', async interval => {
    // risk: invalid scheduler interval escapes the configured bounds
    const policy = new AgentHeartbeatPolicy(new InMemoryDefinitions({ lead }));
    await expect(policy.decide('lead', interval)).resolves.toMatchObject({ allowed: false });
  });

  it('reads changed definitions on every decision instead of caching policy', async () => {
    // risk: revoked heartbeat permission remains active in a long-lived process
    const definitions = new InMemoryDefinitions({ lead });
    const policy = new AgentHeartbeatPolicy(definitions);
    await expect(policy.decide('lead')).resolves.toMatchObject({ allowed: true });
    definitions.set('lead', { ...lead, config: { heartbeat: { ...lead.config.heartbeat, allowed: false } } });
    await expect(policy.decide('lead')).resolves.toMatchObject({ allowed: false });
  });

  it('always allows zero to turn heartbeats off, including for unknown agents', async () => {
    const policy = new AgentHeartbeatPolicy(new InMemoryDefinitions({}));
    await expect(policy.decide('unknown', 0)).resolves.toMatchObject({ allowed: true, intervalMinutes: 0 });
  });

  it('uses lead defaults for the primary persona', async () => {
    const policy = new AgentHeartbeatPolicy(new InMemoryDefinitions({}));
    await expect(policy.decide('sulla')).resolves.toMatchObject({ allowed: true, intervalMinutes: 5 });
  });
});
