// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRONT_DOOR_CHOSEN_KEY } from '@pkg/agent/builtinAgents/index';

const f = vi.hoisted(() => ({ db: null as PGlite | null }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: {
    query:    async() => [],
    queryOne: async(sql: string, params?: unknown[]) => {
      const result = await f.db!.query(sql, params);
      return result.rows[0] ?? null;
    },
  },
}));
vi.mock('@pkg/agent/database/RedisClient', () => ({ redisClient: {} }));

import { AgentDefinitionModel } from '@pkg/agent/database/models/AgentDefinitionModel';

async function frontDoor(slug: string): Promise<boolean | null> {
  const result = await f.db!.query<{ front_door: boolean | null }>('SELECT front_door FROM agent_definitions WHERE slug = $1', [slug]);
  return result.rows[0].front_door;
}

beforeAll(async() => {
  f.db = new PGlite();
  await f.db.exec(`
    CREATE TABLE agent_definitions (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      front_door BOOLEAN,
      config JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
}, 60_000);

afterAll(async() => { await f.db?.close() });

beforeEach(async() => {
  await f.db!.exec('DELETE FROM agent_definitions');
  await f.db!.query(
    `INSERT INTO agent_definitions (id, slug, front_door, config) VALUES
      ('id-legacy', 'legacy-null', NULL, '{"role":"review"}'::jsonb),
      ('id-explicit', 'explicit-null', NULL, $1::jsonb),
      ('id-false', 'already-false', FALSE, '{}'::jsonb),
      ('id-true', 'already-true', TRUE, '{}'::jsonb)`,
    [JSON.stringify({ role: 'review', [FRONT_DOOR_CHOSEN_KEY]: null })],
  );
});

describe('fillFrontDoor refuses an explicit null that landed after the seed read', () => {
  it('fills an unmarked null and leaves a marked null and existing booleans alone', async() => {
    expect(FRONT_DOOR_CHOSEN_KEY).toBe('frontDoorChosen');
    expect(await AgentDefinitionModel.fillFrontDoor('explicit-null', false)).toBe(false);
    expect(await frontDoor('explicit-null')).toBe(null);
    expect(await AgentDefinitionModel.fillFrontDoor('legacy-null', false)).toBe(true);
    expect(await frontDoor('legacy-null')).toBe(false);
    expect(await AgentDefinitionModel.fillFrontDoor('already-false', true)).toBe(false);
    expect(await frontDoor('already-false')).toBe(false);
    expect(await AgentDefinitionModel.fillFrontDoor('already-true', false)).toBe(false);
    expect(await frontDoor('already-true')).toBe(true);
    const kept = await f.db!.query<{ config: { role?: string; frontDoorChosen?: null } }>('SELECT config FROM agent_definitions WHERE slug = $1', ['explicit-null']);
    expect(kept.rows[0].config.role).toBe('review');
    expect(kept.rows[0].config.frontDoorChosen).toBe(null);
  });
});
