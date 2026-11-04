// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { down, up } from '../../../database/migrations/0147_agent_heartbeat_policy';
import { AgentDefinitionModel } from '../../../database/models/AgentDefinitionModel';
import { postgresClient } from '../../../database/PostgresClient';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;
const seeded = { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 1440 };

dbDescribe('AgentDefinition heartbeat config persistence', () => {
  const database = new TestDatabase();

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    await postgresClient.initialize();
  }, 60_000);

  afterAll(async() => {
    await postgresClient.end();
    await database.dispose();
  });

  it('preserves heartbeat on a normal prompt save and preserves other keys on a heartbeat patch', async() => {
    // risk: agent edits silently erase governed heartbeat policy or unrelated config
    const definition = await AgentDefinitionModel.create({
      slug: `config-merge-${ Date.now() }`,
      name: 'Config merge',
      config: { heartbeat: seeded, retained: { enabled: true } },
    });

    const promptSaved = await AgentDefinitionModel.update(definition.id, { promptContent: 'updated prompt' });
    expect(promptSaved?.config).toMatchObject({ heartbeat: seeded, retained: { enabled: true } });

    const heartbeat = { ...seeded, defaultIntervalMinutes: 10 };
    const heartbeatSaved = await AgentDefinitionModel.patchConfig(definition.id, { heartbeat });
    expect(heartbeatSaved?.config).toMatchObject({ heartbeat, retained: { enabled: true } });
    await expect(AgentDefinitionModel.getHeartbeatConfig(definition.id)).resolves.toEqual(heartbeat);
  });

  it('migration up preserves existing heartbeat values and is idempotent', async() => {
    // risk: migration overwrites human policy or changes data on a second run
    const custom = { allowed: false, defaultIntervalMinutes: 12, minIntervalMinutes: 2, maxIntervalMinutes: 60 };
    const definition = await AgentDefinitionModel.create({ slug: 'account-manager', name: 'Account manager', config: { heartbeat: custom, retained: true } });

    await database.query(up);
    await database.query(up);

    const [row] = await database.query<{ config: Record<string, unknown> }>('SELECT config FROM agent_definitions WHERE id = $1', [definition.id]);
    expect(row.config).toEqual({ heartbeat: custom, retained: true });
  });

  it('migration down removes only the exact seeded heartbeat object', async() => {
    // risk: rollback destroys a human-edited policy
    const exact = await AgentDefinitionModel.create({ slug: 'director', name: 'Director', config: { heartbeat: seeded, retained: true } });
    const editedHeartbeat = { ...seeded, defaultIntervalMinutes: 10 };
    const edited = await AgentDefinitionModel.create({ slug: 'heartbeat', name: 'Heartbeat', config: { heartbeat: editedHeartbeat, retained: true } });

    await database.query(down);

    const exactRow = await AgentDefinitionModel.get(exact.id);
    const editedRow = await AgentDefinitionModel.get(edited.id);
    expect(exactRow?.config).toEqual({ retained: true });
    expect(editedRow?.config).toEqual({ heartbeat: editedHeartbeat, retained: true });
  });
});
