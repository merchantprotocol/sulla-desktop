// SPDX-License-Identifier: GPL-2.0-or-later
// Real Postgres: the published-agent upsert must report the registered id through its own SQL.
// Files, the subscription authority, and the Redis cache are faked.
import '../../Support/TestHomeEnv';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestDatabase } from '../../Support/TestDatabase';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {}, Notification: { isSupported: () => false } }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: async() => [], uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));
const accounts = vi.hoisted(() => ({ grok: 'oauth', codex: 'approved-codex' }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: () => ({
  getActiveAccountId: async(provider: keyof typeof accounts) => accounts[provider],
  getAccounts: async(provider: keyof typeof accounts) => [{ account_id: accounts[provider], connected: true }],
}) }));
vi.mock('@pkg/agent/nodes/ThreadStateStore', () => ({ saveThreadState: vi.fn() }));

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('published agent activation on real Postgres', () => {
  const database = new TestDatabase();
  const run = randomUUID().slice(0, 8);
  const slug = `grok-pr-reviewer-${ run }`;
  const existingSlug = `local-reviewer-${ run }`;
  const removedSlug = `removed-reviewer-${ run }`;
  const failSequence = `published_agent_fail_${ run }`;
  const failFunction = `published_agent_fail_fn_${ run }`;
  const failTrigger = `published_agent_fail_tr_${ run }`;
  const fileId = randomUUID(), existingFileId = randomUUID(), v1 = randomUUID(), v2 = randomUUID();
  let rows: { id: string; path: string; published_version_id: string }[] = [];
  let contents = new Map<string, string>();
  let refuseConflictAudit = false;
  let audits: Array<{ action: string; fileId: string; versionId: string; details: { message: string } }>;
  let currentVersion: string | undefined;
  let modelRouter: typeof import('../../../languagemodels/modelRouter').modelRouter;
  let withWorkerBindingWrite: typeof import('../../../languagemodels/workerBindingAuthority').withWorkerBindingWrite;
  const codex = { provider: 'codex', model: 'qa-codex', effort: 'high' };
  const grok = { provider: 'grok', model: 'grok-4.7' };
  const fallback = { provider: 'grok', model: 'grok-4.5' };
  const readBinding = async(name: string) => (await modelRouter.getEditableState()).workerBindings?.[name];
  const databaseRouting = async() => JSON.parse((await database.query(`SELECT value FROM sulla_settings WHERE property='modelRouting'`))[0].value as string);
  let postgresClient: typeof import('../../../database/PostgresClient').postgresClient;
  let SullaUseCaseFiles: typeof import('@pkg/main/sullaUseCaseFiles').SullaUseCaseFiles;

  const manifest = (name: string, model: string, prompt: string) => `slug: ${ name }\nname: ${ name }\nprovider: grok\nmodel: ${ model }\nsystemPrompt: ${ prompt }\n`;
  const publish = (fileId: string, name: string, versionId: string, body: string) => {
    rows = [...rows.filter(row => row.id !== fileId), { id: fileId, path: `Use Cases/agents/${ name }/agent.yaml`, published_version_id: versionId }];
    contents.set(`${ fileId }:${ versionId }`, body);
  };
  const files = async(endpoint: string, init?: RequestInit): Promise<Response> => {
    if (endpoint === '/v1/local/system-areas') return Response.json([{ id: 'home', systemArea: 'sulla' }]);
    if (endpoint.startsWith('/v1/files?')) return Response.json(rows);
    const preview = /^\/v1\/files\/([^/]+)\/preview\?versionId=(.+)$/.exec(endpoint);
    if (preview) return new Response(contents.get(`${ decodeURIComponent(preview[1]) }:${ decodeURIComponent(preview[2]) }`) ?? '', { status: 200 });
    const metadata = /^\/v1\/files\/([^/]+)$/.exec(endpoint);
    if (metadata) {
      const row = rows.find(item => item.id === decodeURIComponent(metadata[1]));
      return row ? Response.json({ ...row, published_version_id: currentVersion ?? row.published_version_id }) : new Response(null, { status: 404 });
    }
    if (endpoint === '/v1/local/system-areas/audit') {
      const entry = JSON.parse(String(init?.body));
      if (refuseConflictAudit && entry.action === 'use-case-model-conflict') return new Response(null, { status: 503 });
      audits.push(entry);
      return Response.json({ ok: true });
    }
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
    const { SullaSettingsModel } = await import('../../../database/models/SullaSettingsModel');
    // Simulate the completed settings bootstrap without touching the real installation cache.
    Object.defineProperty(SullaSettingsModel, 'isReady', { writable: true, value: true });
    const { redisClient } = await import('../../../database/RedisClient');
    vi.spyOn(redisClient, 'hget').mockResolvedValue(null);
    vi.spyOn(redisClient, 'hset').mockResolvedValue(1);
    ({ modelRouter } = await import('../../../languagemodels/modelRouter'));
    ({ withWorkerBindingWrite } = await import('../../../languagemodels/workerBindingAuthority'));
    vi.spyOn(modelRouter, 'providerInfo').mockResolvedValue([
      { id: 'grok', connected: true, models: [{ id: grok.model }, { id: fallback.model }] },
      { id: 'codex', connected: true, models: [{ id: codex.model, efforts: [{ id: 'high' }] }] },
    ] as Awaited<ReturnType<typeof modelRouter.providerInfo>>);
    await modelRouter.getEditableState();
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
    await database.query('DELETE FROM agent_definitions WHERE slug = ANY($1::text[])', [[slug, existingSlug, removedSlug]]).catch(() => undefined);
    await database.dispose();
  });

  beforeEach(() => { rows = []; contents = new Map(); audits = []; currentVersion = undefined; refuseConflictAudit = false; accounts.codex = 'approved-codex' });

  it('rolls back a failed first registration, then activates with the routed id and keeps it on later versions', async() => {
    publish(fileId, slug, v1, manifest(slug, 'grok-4.7', 'Review the approved pull request head.'));
    const service = new SullaUseCaseFiles(files);

    await expect(service.scan()).rejects.toThrow('activation will retry');
    expect(await agent(slug)).toBeFalsy();
    expect((await databaseRouting()).workerBindings?.[slug]).toBeUndefined();

    await service.scan();
    const first = await agent(slug);
    const routedId = first!.id;
    expect(first).toMatchObject({ enabled: true, status: 'production', source_kind: 'local', use_case_version_id: v1, provider: 'grok' });
    expect(await readBinding(slug)).toMatchObject({ agentId: routedId, candidates: [grok], filePublication: { fileId, versionId: v1, revision: 1 } });
    const firstBinding = await readBinding(slug);
    await new SullaUseCaseFiles(files).scan();
    expect(await readBinding(slug)).toEqual(firstBinding);

    publish(fileId, slug, v2, manifest(slug, 'grok-4.5', 'Review the updated pull request head.'));
    await service.scan();
    expect(await agent(slug)).toMatchObject({ id: routedId, enabled: true, use_case_version_id: v2, system_prompt: 'Review the updated pull request head.' });
    expect(await readBinding(slug)).toMatchObject({ agentId: routedId, candidates: [fallback], filePublication: { fileId, versionId: v2, revision: 2 } });
    const v3 = randomUUID();
    publish(fileId, slug, v3, manifest(slug, 'grok-4.5', 'Change only the prompt.'));
    await service.scan();
    expect(await readBinding(slug)).toMatchObject({ agentId: routedId, candidates: [fallback], filePublication: { fileId, versionId: v3, revision: 3 } });
  });

  it('activates a package over an existing local agent without changing its id', async() => {
    await database.query(`INSERT INTO agent_definitions(id,slug,name,source_kind,status,enabled) VALUES($1,$2,$3,'local','draft',FALSE)`, [`agent-existing-${ run }`, existingSlug, 'Existing reviewer']);
    publish(existingFileId, existingSlug, v1, manifest(existingSlug, 'grok-4.7', 'Review as before.'));
    await new SullaUseCaseFiles(files).scan();
    expect(await agent(existingSlug)).toMatchObject({ id: `agent-existing-${ run }`, enabled: true, status: 'production', use_case_version_id: v1 });
    expect(await readBinding(existingSlug)).toMatchObject({ agentId: `agent-existing-${ run }`, candidates: [grok] });
  });

  it('keeps an editor-removed agent out after a fresh scan while retaining its Files package', async() => {
    publish(fileId, removedSlug, v1, manifest(removedSlug, 'grok-4.7', 'Original prompt.'));
    await new SullaUseCaseFiles(files).scan();
    const first = await agent(removedSlug);
    expect(first).toMatchObject({ enabled: true, use_case_version_id: v1 });
    const { AgentDefinitionModel } = await import('../../../database/models/AgentDefinitionModel');
    const publisher = { announce: vi.fn() };
    expect(await AgentDefinitionModel.removeFromEditor(first!.id, publisher)).toEqual({ slug: removedSlug, archived: true });
    expect(publisher.announce).toHaveBeenCalledWith({ type: 'agent', slug: removedSlug, change: 'deleted' });

    publish(fileId, removedSlug, v2, manifest(removedSlug, 'grok-4.7', 'A later published version.'));
    await new SullaUseCaseFiles(files).scan();
    await database.query('UPDATE use_case_files_state SET initial_export_completed_at=NULL WHERE singleton=TRUE');
    try { await new SullaUseCaseFiles(files).scan() } finally {
      await database.query('UPDATE use_case_files_state SET initial_export_completed_at=NOW() WHERE singleton=TRUE');
    }
    expect(await agent(removedSlug)).toMatchObject({ id: first!.id, enabled: false, status: 'archive', use_case_version_id: v1 });
    expect(rows).toHaveLength(1);
    expect(await readBinding(removedSlug)).toMatchObject({ agentId: first!.id, filePublication: { versionId: v1 } });
  });

  it('preserves a manual tier edit and then an explicit return to inheritance on later approved versions', async() => {
    const name = `owner-${ run }`;
    const ownFile = randomUUID();
    const tierText = (candidate: typeof grok) => `apiVersion: sulla/v3
kind: Agent
manifestVersion: 1
metadata: {slug: ${ name }, title: Owner}
spec:
  prompt: Review the work.
  models:
    version: 1
    tiers:
      - candidates: [{provider: ${ candidate.provider }, model: ${ candidate.model }}]
`;
    const service = new SullaUseCaseFiles(files);
    publish(ownFile, name, v1, tierText(grok));
    await service.scan();
    const fileBinding = (await readBinding(name))!;
    const agentId = fileBinding.agentId;
    expect(fileBinding.modelTiers?.tiers).toEqual([{ candidates: [grok] }]);
    await withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(name, agentId, { token: fileBinding.editToken!, revision: 1 }, {
      editToken: 'owner-edit', candidates: [codex], connections: { codex: 'approved-codex' },
    }));
    publish(ownFile, name, v2, tierText(fallback));
    refuseConflictAudit = true;
    await expect(service.scan()).rejects.toThrow('activation will retry');
    expect(await agent(name)).toMatchObject({ id: agentId, use_case_version_id: v1 });
    expect(await readBinding(name)).toMatchObject({ candidates: [codex], revision: 2 });
    expect(audits.some(entry => entry.action === 'use-case-model-conflict')).toBe(false);
    refuseConflictAudit = false;
    audits = [];
    await service.scan();
    expect(await agent(name)).toMatchObject({ id: agentId, use_case_version_id: v2 });
    expect(await readBinding(name)).toMatchObject({ candidates: [codex], revision: 2, filePublication: { versionId: v1, revision: 1 } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ fileId: ownFile, versionId: v2, details: { message: expect.stringContaining('owner') } });
    await new SullaUseCaseFiles(files).scan();
    expect(audits).toHaveLength(1);
    await withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(name, agentId, { token: 'owner-edit', revision: 2 }, null, 'inherit-edit'));
    const v3 = randomUUID();
    publish(ownFile, name, v3, tierText(grok));
    await service.scan();
    expect((await databaseRouting()).workerInheritance[name]).toEqual({ agentId, revision: 3, editToken: 'inherit-edit' });
    expect(await readBinding(name)).toBeUndefined();
    expect(audits[1]).toMatchObject({ fileId: ownFile, versionId: v3, details: { message: expect.stringContaining('shared model routing') } });
    await expect(withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(name, agentId, { token: '', revision: 0 }, {
      editToken: 'stale-tab', candidates: [grok], connections: { grok: 'oauth' },
    }))).rejects.toThrow('changed elsewhere');
  });

  it('rejects a stale listed publication and prevents reuse of a changed subscription', async() => {
    const name = `stale-${ run }`;
    const staleFile = randomUUID();
    const codexText = (effort: string) => `slug: ${ name }
name: Stale fixture
systemPrompt: Test
modelChoice: {mode: pin, provider: codex, model: qa-codex, effort: ${ effort }}
`;
    publish(staleFile, name, v1, codexText('high'));
    currentVersion = v2;
    const service = new SullaUseCaseFiles(files);
    await expect(service.scan()).rejects.toThrow('activation will retry');
    expect(await agent(name)).toBeFalsy();
    expect(await readBinding(name)).toBeUndefined();
    expect(audits[0]).toMatchObject({ fileId: staleFile, versionId: v1, details: { message: expect.stringContaining('newer file publication') } });

    currentVersion = undefined;
    await service.scan();
    const first = await readBinding(name);
    expect(first?.connections).toEqual({ codex: 'approved-codex' });
    accounts.codex = 'different-codex';
    const plain = codexText('high').replace(', effort: high', '');
    publish(staleFile, name, v2, plain);
    await expect(service.scan()).rejects.toThrow('activation will retry');
    expect(await agent(name)).toMatchObject({ use_case_version_id: v1 });
    expect(await readBinding(name)).toEqual(first);
    expect(audits.at(-1)?.details.message).toContain('approved codex subscription account changed');

    const withoutModels = `slug: ${ name }
name: Stale fixture
systemPrompt: Shared model
`;
    const v3 = randomUUID();
    publish(staleFile, name, v3, withoutModels);
    await service.scan();
    expect(await agent(name)).toMatchObject({ id: first!.agentId, use_case_version_id: v3 });
    expect(await readBinding(name)).toBeUndefined();
  });

  it('round-trips grouped Studio exports and inherited profiles through the local import entry', async() => {
    const { exportLocalAgentPackage, importLocalAgentPackage } = await import('@pkg/main/marketplace/localAgentPackages');
    const { agentDefinitionService } = await import('../../../services/AgentDefinitionService');
    const source = await agentDefinitionService.create({
      slug: `export-models-${ run }`, name: 'Studio package', modelChoice: { mode: 'class', class: 'coding' },
    });
    const modelTiers = {
      version: 1 as const, tiers: [{ candidates: [codex, grok] }, { candidates: [fallback] }],
      crossCompanyFallback: false, allowLaunchOverride: 'never' as const,
    };
    await withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(source.slug, source.id, { token: '', revision: 0 }, {
      editToken: 'original', candidates: [codex, grok, fallback], modelTiers,
      connections: { codex: 'approved-codex', grok: 'oauth' },
    }));
    const manifest = await exportLocalAgentPackage(source.slug);
    expect(manifest.spec.models).toEqual(modelTiers);
    expect(JSON.stringify(manifest)).not.toContain('approved-codex');
    expect(manifest.spec.config.modelChoice).toEqual({ mode: 'class', class: 'coding' });
    const importedSlug = `import-models-${ run }`;
    const imported = await importLocalAgentPackage({ ...manifest, metadata: { ...manifest.metadata, slug: importedSlug } });
    expect(imported).toMatchObject({ id: expect.any(String), slug: importedSlug, enabled: true, source_kind: 'local', model_choice: { mode: 'class', class: 'coding' } });
    expect(imported.id).not.toBe(source.id);
    expect(await readBinding(importedSlug)).toMatchObject({
      agentId: imported.id, revision: 1, modelTiers, connections: { codex: 'approved-codex', grok: 'oauth' },
    });

    const reimported = await importLocalAgentPackage(await exportLocalAgentPackage(importedSlug));
    expect(reimported.id).toBe(imported.id);
    expect((await readBinding(importedSlug))?.revision).toBe(1);

    const unsupportedSlug = `unsupported-${ run }`;
    const unsupported = { provider: 'grok', model: 'not-in-live-catalog' };
    const invalid = { ...manifest, metadata: { ...manifest.metadata, slug: unsupportedSlug }, spec: {
      ...manifest.spec, modelChoice: { mode: 'pin' as const, ...unsupported }, models: { tiers: [{ candidates: [unsupported] }] },
    } };
    await expect(importLocalAgentPackage(invalid)).rejects.toThrow('verified catalog');
    expect(await agent(unsupportedSlug)).toBeFalsy();
    expect(await readBinding(unsupportedSlug)).toBeUndefined();

    const inherited = await agentDefinitionService.create({ slug: `export-class-${ run }`, name: 'Inherited profile', modelChoice: { mode: 'class', class: 'fast' } });
    const profile = await exportLocalAgentPackage(inherited.slug);
    expect(profile.spec.models).toBeUndefined();
    const inheritedSlug = `import-class-${ run }`;
    const inheritedAgent = await importLocalAgentPackage({ ...profile, metadata: { ...profile.metadata, slug: inheritedSlug } });
    expect(inheritedAgent.model_choice).toEqual({ mode: 'class', class: 'fast' });
    expect(await readBinding(inheritedSlug)).toBeUndefined();

    const legacySlug = `legacy-import-${ run }`;
    const legacy = { ...profile, metadata: { ...profile.metadata, slug: legacySlug }, spec: {
      ...profile.spec, provider: grok.provider, model: grok.model,
    } };
    const legacyAgent = await importLocalAgentPackage(legacy);
    expect(await readBinding(legacySlug)).toMatchObject({ agentId: legacyAgent.id, candidates: [grok] });
    expect((await readBinding(legacySlug))?.modelTiers).toBeUndefined();
  });

  it('round-trips routine references in an exported local definition', async() => {
    const { agentDefinitionService } = await import('../../../services/AgentDefinitionService');
    const local = await agentDefinitionService.create({ slug: `export-${ run }`, name: 'Export test', routineRefs: ['qa.review'] });
    const manifest = await agentDefinitionService.exportManifest(local.slug);
    expect(manifest.spec.routines).toEqual(['qa.review']);
    const imported = await agentDefinitionService.importManifest({ ...manifest, metadata: { ...manifest.metadata, slug: `import-${ run }` } });
    expect(imported.routine_refs).toEqual(['qa.review']);
    expect(await agentDefinitionService.removeFromEditor(local.id)).toEqual({ slug: local.slug, archived: false });
    expect(await agentDefinitionService.findBySlug(local.slug)).toBeNull();
  });
});
