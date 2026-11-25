// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { migrationsRegistry } from '../../../database/migrations';

describe('migration registry', () => {
  it('keeps the agent-awareness migration on its unique 0172 ledger name', () => {
    const migrationNames = migrationsRegistry.map(migration => migration.name);

    expect(migrationNames).toContain('0172_agent_awareness_setting');
    expect(migrationNames).not.toContain('0171_agent_awareness_setting');
    expect(new Set(migrationNames).size).toBe(migrationNames.length);
  });
});
