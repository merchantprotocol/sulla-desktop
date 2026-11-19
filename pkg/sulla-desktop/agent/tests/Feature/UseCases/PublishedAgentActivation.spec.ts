// SPDX-License-Identifier: GPL-2.0-or-later
// Real Postgres: the published-agent upsert must report the registered id through its own SQL.
// Only the Files service and the provider/model-routing boundary are faked.
import '../../Support/TestHomeEnv';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';

const f = vi.hoisted(() => ({ routes: [] as any[][], removed: [] as any[][], owned: new Map<string, string>() }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {}, Notification: { isSupported: () => false } }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: async() => [], uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));
// Provider boundary: the owner mapping store; live subscription validation is covered by unit specs.
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({ workerModelRouting: {
  initializeBindingForPublishedPackage: vi.fn(async(slug: string, agentId: string, candidates: unknown[]) => {
    f.routes.push([slug, agentId, candidates]);
    const owner = f.owned.get(slug);
    if (owner && owner !== agentId) throw new Error('A different agent already owns this worker mapping; it was preserved.');
    if (owner) return { created: false };
    f.owned.set(slug, agentId);
    return { created: true, binding: { editToken: `created-${ agentId }`, revision: 1 } };
  }),
  removeBindingForDefinition: vi.fn(async(slug: string, agentId: string) => {
    f.removed.push([slug, agentId]);
    if (f.owned.get(slug) === agentId) f.owned.delete(slug);
  }),
} }));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('published agent activation on real Postgres', () => {
  const database = new TestDatabase();
  const run = randomUUID().slice(0, 8);
  const slug = `grok-pr-reviewer-${ run }`;
  const existingSlug = `local-reviewer-${ run }`;
  const failSequence = `published_agent_fail_${ run }`;
  const failFunction = `published_agent_fail_fn_${ run }`;
  const failTrigger = `published_agent_fail_tr_${ run }`;
  const fileId = randomUUID(), existingFileId = randomUUID(), v1 = randomUUID(), v2 = randomUUID();
  let rows: { id: string; path: string; published_version_id: string }[] = [];
  let contents = new Map<string, string>();
  let postgresClient: typeof import('../../../database/PostgresClient').postgresClient;
  let SullaUseCaseFiles: typeof import('@pkg/main/sullaUseCaseFiles').SullaUseCaseFiles;

  const manifest = (name: string, model: string, prompt: string) => `slug: ${ name }\nname: ${ name }\nprovider: grok\nmodel: ${ model }\nsystemPrompt: ${ prompt }\n`;
  const publish = (fileId: string, name: string, versionId: string, body: string) => {
    rows = [...rows.filter(row => row.id !== fileId), { id: fileId, path: `Use Cases/agents/${ name }/agent.yaml`, published_version_id: versionId }];
    contents.set(`${ fileId }:${ versionId }`, body);
  };
  const files = async(endpoint: string): Promise<Response> => {
    if (endpoint === '/v1/local/system-areas') return Response.json([{ id: 'home', systemArea: 'sulla' }]);
    if (endpoint.startsWith('/v1/files?')) return Response.json(rows);
    const preview = /^\/v1\/files\/([^/]+)\/preview\?versionId=(.+)$/.exec(endpoint);
    if (preview) return new Response(contents.get(`${ decodeURIComponent(preview[1]) }:${ decodeURIComponent(preview[2]) }`) ?? '', { status: 200 });
    if (endpoint === '/v1/local/system-areas/audit') return Response.json({ ok: true });
    throw new Error(`Unexpected Files request ${ endpoint }`);
  };
  const agent = async(name: string) => postgresClient.queryOne<{ id: string; enabled: boolean; status: string; source_kind: string; system_prompt: string; use_case_version_id: string; provider: string }>(
    'SELECT id,enabled,status,source_kind,system_prompt,use_case_version_id,provider FROM agent_definitions WHERE slug=$1', [name]);

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    ({ postgresClient } = await import('../../../database/PostgresClient'));
    await postgresClient.initialize();
    await postgresClient.query(`SET search_path TO "${ database.schema }", public`);
    await database.applyMigrations();
    // Skip the one-time legacy export; this spec activates Files packages only.
    await database.query('UPDATE use_case_files_state SET initial_export_completed_at=NOW() WHERE singleton=TRUE');
    // A real database failure inside the first registration transaction (sequences are not rolled back).
    await database.query(`CREATE SEQUENCE "${ failSequence }"`);
    await database.query(`CREATE FUNCTION "${ failFunction }"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.slug = '${ slug }' THEN
        IF nextval('"${ failSequence }"') = 1 THEN RAISE EXCEPTION 'temporary projection failure'; END IF;
      END IF;
      RETURN NEW; END $$`);
    await database.query(`CREATE TRIGGER "${ failTrigger }" BEFORE INSERT OR UPDATE ON agent_definitions FOR EACH ROW EXECUTE FUNCTION "${ failFunction }"()`);
    ({ SullaUseCaseFiles } = await import('@pkg/main/sullaUseCaseFiles'));
  }, 60_000);

  afterAll(async() => {
    await database.query(`DROP TRIGGER IF EXISTS "${ failTrigger }" ON agent_definitions`).catch(() => undefined);
    await database.query(`DROP FUNCTION IF EXISTS "${ failFunction }"()`).catch(() => undefined);
    await database.query(`DROP SEQUENCE IF EXISTS "${ failSequence }"`).catch(() => undefined);
    await database.query('DELETE FROM agent_definitions WHERE slug = ANY($1::text[])', [[slug, existingSlug]]).catch(() => undefined);
    await database.dispose();
  });

  beforeEach(() => { rows = []; contents = new Map(); f.routes = []; f.removed = [] });

  it('rolls back a failed first registration, then activates with the routed id and keeps it on later versions', async() => {
    publish(fileId, slug, v1, manifest(slug, 'grok-4.7', 'Review the approved pull request head.'));
    const service = new SullaUseCaseFiles(files);

    await expect(service.scan()).rejects.toThrow('activation will retry');
    expect(await agent(slug)).toBeFalsy();
    const routedId = f.routes[0][1];
    expect(f.removed).toEqual([[slug, routedId]]);

    await service.scan();
    const first = await agent(slug);
    expect(first).toMatchObject({ id: routedId, enabled: true, status: 'production', source_kind: 'local', use_case_version_id: v1, provider: 'grok' });
    expect(f.routes.map(route => route[1])).toEqual([routedId, routedId]);
    expect(f.owned.get(slug)).toBe(routedId);

    // An unchanged listing is not re-registered.
    await service.scan();
    expect(f.routes).toHaveLength(2);

    // A newly published version (with a different package pin) updates the same identity and keeps the owner mapping.
    publish(fileId, slug, v2, manifest(slug, 'grok-4.5', 'Review the updated pull request head.'));
    await service.scan();
    expect(await agent(slug)).toMatchObject({ id: routedId, enabled: true, use_case_version_id: v2, system_prompt: 'Review the updated pull request head.' });
    expect(f.routes.at(-1)?.slice(0, 2)).toEqual([slug, routedId]);
    expect(f.removed).toHaveLength(1);
  });

  it('activates a package over an existing local agent without changing its id', async() => {
    await database.query(`INSERT INTO agent_definitions(id,slug,name,source_kind,status,enabled) VALUES($1,$2,$3,'local','draft',FALSE)`, [`agent-existing-${ run }`, existingSlug, 'Existing reviewer']);
    publish(existingFileId, existingSlug, v1, manifest(existingSlug, 'grok-4.7', 'Review as before.'));
    await new SullaUseCaseFiles(files).scan();
    expect(await agent(existingSlug)).toMatchObject({ id: `agent-existing-${ run }`, enabled: true, status: 'production', use_case_version_id: v1 });
    expect(f.routes[0].slice(0, 2)).toEqual([existingSlug, `agent-existing-${ run }`]);
    expect(f.removed).toEqual([]);
  });
});
