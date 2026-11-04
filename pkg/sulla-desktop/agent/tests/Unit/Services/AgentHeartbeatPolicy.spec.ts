// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { AgentHeartbeatPolicy } from '../../../services/AgentHeartbeatPolicy';

class InMemoryDefinitions {
  constructor(private readonly rows: Record<string, any>) {}
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
    await expect(policy.decide('bad')).resolves.toMatchObject({ allowed: false });
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
