// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { migrationsRegistry } from '../../../database/migrations';
import { up as awarenessMigration } from '../../../database/migrations/0172_agent_awareness_setting';
import { AgentAwarenessDefaults } from '../../../services/AgentAwarenessDefaults';

describe('migration registry', () => {
  it('keeps the agent-awareness migration on its unique 0172 ledger name', () => {
    const migrationNames = migrationsRegistry.map(migration => migration.name);

    expect(migrationNames).toContain('0172_agent_awareness_setting');
    expect(migrationNames).not.toContain('0171_agent_awareness_setting');
    expect(new Set(migrationNames).size).toBe(migrationNames.length);
  });

  it('backfills defaults from the shared built-in slug lists', () => {
    expect(awarenessMigration).toContain(`slug IN (${ AgentAwarenessDefaults.DEFAULT_OFF_AGENT_SLUG_SQL })`);
    expect(awarenessMigration).toContain(`slug IN (${ AgentAwarenessDefaults.DEFAULT_ON_AGENT_SLUG_SQL })`);
  });
});
