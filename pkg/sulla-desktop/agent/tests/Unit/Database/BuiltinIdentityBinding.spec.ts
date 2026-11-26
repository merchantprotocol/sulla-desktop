// SPDX-License-Identifier: GPL-2.0-or-later
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

import { up } from '@pkg/agent/database/migrations/0174_builtin_agent_identities';
import { captureWorkerRoute } from '@pkg/agent/languagemodels/workerModelBindings';
import type { PoolClient } from 'pg';

it('preserves an owned route across an orphan collision and rolls back on an ambiguous live owner', async() => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE agent_definitions(id text PRIMARY KEY, slug text UNIQUE, name text, is_builtin boolean, can_call text[], builtin_hash text);
      CREATE TABLE agent_builtin_seed_ledger(slug text PRIMARY KEY);
      CREATE TABLE sulla_settings(property text PRIMARY KEY, value text);
      INSERT INTO agent_definitions VALUES ('stable','opus-worker','Opus Worker',true,'{}',null),('other','custom','Custom',false,'{}',null);
    `);
    const owned = { agentId:'stable', revision:7, editToken:'edit', candidates:[{ provider:'codex', model:'example' }], connections:{ codex:'approved' } };
    const route = async() => {
      const { rows:[row] } = await db.query<{ slug:string; id:string; value:string }>(
        "SELECT slug,id,value FROM agent_definitions,sulla_settings WHERE id='stable' AND property='modelRouting'");
      return captureWorkerRoute(row.slug, row.id, JSON.parse(row.value).workerBindings);
    };
    for (const owner of ['other', 'deleted']) {
      await db.query(`INSERT INTO sulla_settings VALUES ('modelRouting',$1) ON CONFLICT(property) DO UPDATE SET value=EXCLUDED.value`,
        [JSON.stringify({ workerBindings:{ 'opus-worker':owned, advisor:{ ...owned, agentId:owner } } })]);
      const migrate = db.transaction(tx => up(tx as unknown as PoolClient));
      if (owner === 'other') {
        await expect(migrate).rejects.toThrow(/conflicting definition ownership/);
        expect(await route()).toMatchObject({ ...owned, slug:'opus-worker' });
      } else {
        await migrate;
        expect(await route()).toMatchObject({ ...owned, slug:'advisor' });
      }
    }
  } finally { await db.close() }
});
