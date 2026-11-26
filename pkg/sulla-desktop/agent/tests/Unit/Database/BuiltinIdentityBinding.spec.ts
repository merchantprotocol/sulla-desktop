// SPDX-License-Identifier: GPL-2.0-or-later
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { up } from '@pkg/agent/database/migrations/0174_builtin_agent_identities';
import { captureWorkerRoute } from '@pkg/agent/languagemodels/workerModelBindings';

import type { PoolClient } from 'pg';

let db: PGlite;
const owned = { agentId: 'stable', revision: 7, editToken: 'edit', candidates: [{ provider: 'codex', model: 'example' }], connections: { codex: 'approved' } };
const other = { ...owned, agentId: 'other' };
const inheritance = { agentId: 'stable', revision: 2 };

beforeAll(async() => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE agent_definitions(id text PRIMARY KEY, slug text UNIQUE, name text, is_builtin boolean, can_call text[], builtin_hash text);
    CREATE TABLE agent_builtin_seed_ledger(slug text PRIMARY KEY);
    CREATE TABLE sulla_settings(property text PRIMARY KEY, value text);
    CREATE TABLE sulla_migrations(name text PRIMARY KEY);
  `);
});
afterAll(async() => db?.close());
beforeEach(async() => {
  await db.exec(`
    TRUNCATE agent_definitions, agent_builtin_seed_ledger, sulla_settings, sulla_migrations;
    INSERT INTO agent_definitions VALUES ('stable','opus-worker','Opus Worker',true,'{}',null),
      ('other','custom','Custom',false,'{opus-worker,haiku-worker}',null), ('movable','haiku-worker','Haiku Worker',true,'{}',null);
    INSERT INTO agent_builtin_seed_ledger VALUES ('sonnet-worker');
    INSERT INTO sulla_settings VALUES ('defaultAgentId','opus-worker'),
      ('modelDefaults','{"chat":{"kind":"agent","agentId":"opus-worker"},"heartbeat":{"kind":"agent","agentId":"haiku-worker"}}'),
      ('productOwnerWorkflow.chat.mockup','{"agentSlug":"opus-worker","agentId":"stable"}');
    INSERT INTO sulla_migrations VALUES ('0170_another_migration');
  `);
});

const migrate = () => db.transaction(tx => up(tx as unknown as PoolClient));
const setMaps = (maps: object) => db.query("INSERT INTO sulla_settings VALUES ('modelRouting',$1)", [JSON.stringify(maps)]);
async function snapshot() {
  const defs = (await db.query<{ id: string; slug: string; name: string; can_call: string[] }>(
    'SELECT id,slug,name,can_call FROM agent_definitions ORDER BY id')).rows;
  const settings = Object.fromEntries((await db.query<{ property: string; value: string }>('SELECT * FROM sulla_settings')).rows.map(r => [r.property, r.value]));
  const routing = JSON.parse(settings.modelRouting);
  const stable = defs.find(r => r.id === 'stable')!;
  return { defs, settings, stable, routing, route: captureWorkerRoute(stable.slug, stable.id, routing.workerBindings ?? {}),
    seen: (await db.query<{ slug: string }>('SELECT slug FROM agent_builtin_seed_ledger ORDER BY slug')).rows.map(r => r.slug) };
}

it.each([
  { label: 'live pin owner', workerBindings: { 'opus-worker': owned, advisor: other } },
  { label: 'missing owner', workerBindings: { 'opus-worker': owned, advisor: {} } },
  { label: 'empty owner', workerBindings: { 'opus-worker': owned, advisor: { agentId: '' } } },
  { label: 'cross-map inheritance conflict', workerBindings: { 'opus-worker': owned }, workerInheritance: { advisor: other } },
  { label: 'inheritance-only live owner', workerInheritance: { 'opus-worker': inheritance, advisor: other } },
  { label: 'dormant same-ID pin', workerInheritance: { 'opus-worker': inheritance }, workerBindings: { advisor: owned } },
  { label: 'destination without an owned source', workerBindings: { advisor: other } },
])('defers only the unsafe pair: $label', async({ label: _label, ...maps }) => {
  await setMaps(maps);
  const before = await snapshot();
  await migrate();
  const after = await snapshot();
  expect(after.stable).toEqual(before.stable);
  expect(after.route).toEqual(before.route);
  expect(after.routing).toEqual(maps);
  expect(after.settings.defaultAgentId).toBe('opus-worker');
  expect(JSON.parse(after.settings.modelDefaults)).toEqual({ chat: { kind: 'agent', agentId: 'opus-worker' }, heartbeat: { kind: 'agent', agentId: 'lookup' } });
  expect(after.settings['productOwnerWorkflow.chat.mockup']).toBe(before.settings['productOwnerWorkflow.chat.mockup']);
  expect(after.defs).toContainEqual(expect.objectContaining({ id: 'other', can_call: ['opus-worker', 'lookup'] }));
  expect(after.defs).toContainEqual(expect.objectContaining({ id: 'movable', slug: 'lookup' }));
  expect(after.seen).toEqual(expect.arrayContaining(['advisor', 'generalist']));
  await migrate();
  expect(await snapshot()).toEqual(after);
});

it.each(['deleted', 'stable'])('transfers the complete pin over a %s owner without taking foreign inheritance', async(agentId) => {
  await setMaps({ workerBindings: { 'opus-worker': owned, advisor: { agentId } }, workerInheritance: { 'opus-worker': other } });
  await migrate();
  const after = await snapshot();
  expect(after.stable.slug).toBe('advisor');
  expect(after.route).toMatchObject({ ...owned, slug: 'advisor' });
  expect(after.routing).toEqual({ workerBindings: { advisor: owned }, workerInheritance: { 'opus-worker': other } });
  expect(after.settings.defaultAgentId).toBe('advisor');
  expect(JSON.parse(after.settings['productOwnerWorkflow.chat.mockup']).agentSlug).toBe('advisor');
});

it('leaves every row and marker unchanged after the exact Dev ledger entry', async() => {
  await setMaps({});
  await db.query("INSERT INTO sulla_migrations VALUES ('0170_builtin_agent_identities')");
  const before = await snapshot();
  await migrate();
  expect(await snapshot()).toEqual(before);
});
