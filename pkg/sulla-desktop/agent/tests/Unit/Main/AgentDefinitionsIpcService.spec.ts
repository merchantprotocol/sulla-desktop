// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { postgresClient } from '../../../database/PostgresClient';
import { AgentDefinitionService } from '../../../services/AgentDefinitionService';
import { AgentDefinitionsIpcService } from '../../../../main/AgentDefinitionsIpcService';
import { TestDatabase } from '../../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;
const validHeartbeat = { allowed: true, defaultIntervalMinutes: 5, minIntervalMinutes: 1, maxIntervalMinutes: 60 };

dbDescribe('AgentDefinitionsIpcService', () => {
  const database = new TestDatabase();
  const service = new AgentDefinitionsIpcService(new AgentDefinitionService());

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    await postgresClient.initialize();
  }, 60_000);

  afterAll(async() => {
    await postgresClient.end();
    await database.dispose();
  });

  it('persists validated heartbeat config through create and update', async() => {
    // risk: renderer reports saved governance settings that main never persists
    const created = await service.create({
      slug: `ipc-heartbeat-${ Date.now() }`,
      name: 'IPC heartbeat',
      prompt: 'Initial prompt',
      heartbeat: validHeartbeat,
    });
    expect(created.config.heartbeat).toEqual(validHeartbeat);

    const updatedHeartbeat = { ...validHeartbeat, defaultIntervalMinutes: 10 };
    const updated = await service.update(created.id, { prompt: 'Updated prompt', heartbeat: updatedHeartbeat });
    expect(updated).toMatchObject({ prompt_content: 'Updated prompt', config: { heartbeat: updatedHeartbeat } });
  });

  it('rejects invalid heartbeat config before creating or updating a definition', async() => {
    // risk: malformed scheduler bounds are accepted through the privileged main-process IPC path
    const slug = `ipc-invalid-${ Date.now() }`;
    await expect(service.create({
      slug,
      name: 'Invalid IPC heartbeat',
      prompt: 'Prompt',
      heartbeat: { ...validHeartbeat, maxIntervalMinutes: 1441 },
    })).rejects.toThrow('config.heartbeat.maxIntervalMinutes');
    expect(await new AgentDefinitionService().findBySlug(slug)).toBeNull();

    const valid = await service.create({ slug: `${ slug }-update`, name: 'Valid', prompt: 'Original' });
    await expect(service.update(valid.id, {
      prompt: 'Must not save',
      heartbeat: { ...validHeartbeat, minIntervalMinutes: 20, maxIntervalMinutes: 10 },
    })).rejects.toThrow('config.heartbeat.minIntervalMinutes/maxIntervalMinutes');
    expect((await new AgentDefinitionService().get(valid.id))?.prompt_content).toBe('Original');
  });
});
