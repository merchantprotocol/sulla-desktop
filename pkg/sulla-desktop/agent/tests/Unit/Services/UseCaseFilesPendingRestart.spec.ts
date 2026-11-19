// SPDX-License-Identifier: GPL-2.0-or-later
// Restart safety of a pending-migration agent registration. Each "restart" is a brand-new
// SullaUseCaseFiles over durable state only: agent definitions on real SQL (PGlite) and the real
// modelRouter/WorkerModelRouting mapping logic over a persisted settings store. Faked boundaries:
// the Files HTTP API, provider subscription validation, and the settings store's storage.
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  db: undefined as any,
  settings: new Map<string, unknown>(),
  failSettingsWrites: 0,
  beforeTransaction: undefined as undefined | (() => Promise<void>),
}));

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/agent/database/PostgresClient', () => {
  const run = async(text: string, params: any[] = []) => { const r = await f.db.query(text, params); return { rows: r.rows, rowCount: r.affectedRows ?? null } };
  return { postgresClient: {
    query:    async(text: string, params?: any[]) => (await run(text, params)).rows,
    queryOne: async(text: string, params?: any[]) => (await run(text, params)).rows[0] ?? null,
    transaction: async(work: (client: any) => Promise<unknown>) => {
      await f.beforeTransaction?.();
      await f.db.query('BEGIN');
      try { const result = await work({ query: run }); await f.db.query('COMMIT'); return result } catch (error) { await f.db.query('ROLLBACK'); throw error }
    },
  } };
});
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {
  get: vi.fn(async(key: string, fallback: unknown) => structuredClone(f.settings.has(key) ? f.settings.get(key) : fallback)),
  set: vi.fn(async(key: string, value: unknown) => {
    if (f.failSettingsWrites > 0) { f.failSettingsWrites--; throw new Error('settings store temporarily unavailable') }
    f.settings.set(key, structuredClone(value));
  }),
} }));
vi.mock('@pkg/agent/languagemodels/index', () => ({ PROVIDER_FACTORIES: { grok: {}, codex: {}, 'claude-code': {} } }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: () => ({ onValueChange: vi.fn() }) }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: vi.fn(async() => []), uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));
vi.mock('@pkg/agent/database/repositories/UseCaseRemovalRepository', () => ({ UseCaseRemovalRepository: class { async listRemoved() { return [] } } }));
vi.mock('@pkg/main/marketplace/databaseArtifacts', () => ({ readDatabaseArtifact: vi.fn(async() => { throw new Error('legacy export must not run') }) }));

import { modelRouter } from '@pkg/agent/languagemodels/modelRouter';
import { withWorkerBindingWrite } from '@pkg/agent/languagemodels/workerBindingAuthority';
import { agentDefinitionService } from '@pkg/agent/services/AgentDefinitionService';
import { workerModelRouting } from '@pkg/agent/services/WorkerModelRouting';
import { SullaUseCaseFiles } from '@pkg/main/sullaUseCaseFiles';

const SCHEMA = `
  CREATE TABLE use_case_files_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), initial_export_completed_at TIMESTAMPTZ, last_scan_at TIMESTAMPTZ, last_error TEXT);
  INSERT INTO use_case_files_state(singleton) VALUES (TRUE);
  CREATE TABLE agent_definitions (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
    soul_content TEXT NOT NULL DEFAULT '', allowed_tools TEXT[] NOT NULL DEFAULT '{}', skill_refs TEXT[] NOT NULL DEFAULT '{}', routine_refs TEXT[] NOT NULL DEFAULT '{}',
    model_priority JSONB NOT NULL DEFAULT '[]'::jsonb, version TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','production','archive')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE, config JSONB NOT NULL DEFAULT '{}'::jsonb, prompt_content TEXT NOT NULL DEFAULT '', goals_content TEXT NOT NULL DEFAULT '',
    prompt_files JSONB NOT NULL DEFAULT '{}'::jsonb, provider TEXT, model TEXT, model_slot TEXT,
    source_kind TEXT NOT NULL DEFAULT 'local' CHECK (source_kind IN ('local','filesystem-import','marketplace')),
    when_to_call TEXT NOT NULL DEFAULT '', when_not_to_call TEXT NOT NULL DEFAULT '', send TEXT NOT NULL DEFAULT '', returns TEXT NOT NULL DEFAULT '',
    cost_tier TEXT CHECK (cost_tier IS NULL OR cost_tier IN ('low','medium','high')), can_call TEXT[] NOT NULL DEFAULT '{}', front_door BOOLEAN,
    use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const SLUG = 'qa-chat-grok-20261117';
const FILE = '6c6bc5bd-80ee-492e-b090-1b2f2735dbc0';
const V1 = '99786748-b1a9-4765-bfe7-5bd05e0f146b';
const ROOT_PATH = `Use Cases/agents/${ SLUG }/agent.yaml`;
const V2 = '0f6e1a52-6d7b-4c1e-9a43-2f1d8b0c7e11';
const manifestFor = (model?: string) => `slug: ${ SLUG }\nname: QA chat Grok\n${ model ? `provider: grok\nmodel: ${ model }\n` : '' }systemPrompt: Answer MENU_AGENT_OK.\n`;
let MANIFEST = manifestFor('grok-4.7');
let approved = true;
let version = V1;
let audits: string[] = [];
/** The stable registration identity for this slug and root file, independent of version. */
const AGENT_ID = `agent-${ createHash('sha256').update(`sulla-use-case-agent\0${ SLUG }\0${ FILE }`).digest('hex').slice(0, 32) }`;

async function files(endpoint: string, init: RequestInit = {}): Promise<Response> {
  if (endpoint === '/v1/local/system-areas') return Response.json([{ id: 'home', systemArea: 'sulla' }]);
  if (endpoint.startsWith('/v1/files?')) return Response.json([{ id: FILE, path: ROOT_PATH, published_version_id: version }]);
  if (endpoint.startsWith('/v1/files/publish-requests?')) return Response.json({ requests: approved ? [{ file_id: FILE, version_id: version, status: 'approved', path: ROOT_PATH }] : [] });
  if (endpoint.startsWith(`/v1/files/${ FILE }/preview`)) return new Response(MANIFEST, { status: 200 });
  if (endpoint === '/v1/local/system-areas/audit') { audits.push(String(init.body ?? '')); return Response.json({ ok: true }) }
  return Response.json({ error: `unexpected ${ endpoint }` }, { status: 500 });
}

const binding = async() => (await modelRouter.getEditableState()).workerBindings?.[SLUG] as any;
const agent = async() => (await f.db.query('SELECT * FROM agent_definitions WHERE slug=$1', [SLUG])).rows[0];
const restart = () => new SullaUseCaseFiles(files);
const insertRacer = () => f.db.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled,model,source_kind) VALUES ('agent-racer','${ SLUG }','Racer','draft',FALSE,'grok-4.5','local')`);

beforeAll(async() => { f.db = new PGlite() }, 60_000);
afterAll(async() => { await f.db?.close() });
beforeEach(async() => {
  await f.db.exec('DROP TABLE IF EXISTS use_case_files_state, agent_definitions;');
  await f.db.exec(SCHEMA);
  f.settings.clear(); f.failSettingsWrites = 0; f.beforeTransaction = undefined; approved = true; version = V1; audits = []; MANIFEST = manifestFor('grok-4.7');
  vi.spyOn(workerModelRouting, 'validateSubscriptionCandidates').mockResolvedValue({ grok: 'grok-oauth-account' });
  // Definition lookup for new routes reads the same SQL rows.
  vi.spyOn(agentDefinitionService, 'findBySlug').mockImplementation(async(slug: string) => (await f.db.query('SELECT * FROM agent_definitions WHERE slug=$1', [slug])).rows[0] ?? null);
});

describe('pending registration recovery across an app restart', () => {
  /** A competing definition wins the slug after the mapping was written, and removing it fails once. */
  async function lostRaceThenCrash() {
    f.beforeTransaction = async() => { f.beforeTransaction = undefined; await insertRacer(); f.failSettingsWrites = 1 };
    await expect(restart().scan()).rejects.toThrow(/mapping could not be removed/);
    const stale = await binding();
    expect(stale).toMatchObject({ agentId: expect.stringMatching(/^agent-/), revision: 1 });
    expect(stale.agentId).not.toBe('agent-racer');
    return stale;
  }

  it('removes exactly the stale package mapping after a restart and keeps the winning definition', async() => {
    await lostRaceThenCrash();
    const racer = await agent();
    await restart().scan();
    expect(await binding()).toBeUndefined();
    expect(await agent()).toEqual(racer);
  });

  it('keeps failing visibly after a restart while the removal still fails, then repairs it', async() => {
    await lostRaceThenCrash();
    f.failSettingsWrites = 1;
    await expect(restart().scan()).rejects.toThrow('settings store temporarily unavailable');
    expect(await binding()).toBeDefined();
    await restart().scan();
    expect(await binding()).toBeUndefined();
  });

  it("preserves the owner's newer mapping saved before the restart", async() => {
    const stale = await lostRaceThenCrash();
    // The owner saves a mapping for the winning agent in AI Models (exact compare-and-set).
    await withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(SLUG, 'agent-racer',
      { token: '', revision: 0, entry: { agentId: stale.agentId, editToken: stale.editToken, revision: stale.revision } },
      { editToken: 'owner-token', connections: { grok: 'grok-oauth-account' }, candidates: [{ provider: 'grok', model: 'grok-4.5' }] }));
    const owner = await binding();
    await restart().scan();
    expect(await binding()).toEqual(owner);
    expect(owner).toMatchObject({ agentId: 'agent-racer', editToken: 'owner-token' });
    expect(owner).not.toHaveProperty('pendingPublication');
  });

  it('settles a registration that committed but crashed before its marker was cleared, without touching the row or mapping', async() => {
    // The definition commits; the settings write that settles its marker is lost.
    f.beforeTransaction = async() => { f.beforeTransaction = undefined; f.failSettingsWrites = 1 };
    await restart().scan().catch(() => undefined);
    const registered = await agent();
    expect(registered).toMatchObject({ enabled: true, use_case_file_id: FILE, use_case_version_id: V1 });
    expect(await binding()).toMatchObject({ agentId: registered.id, pendingPublication: { fileId: FILE, versionId: V1 } });
    // The owner then disables the agent.
    await f.db.query(`UPDATE agent_definitions SET enabled=FALSE,status='draft' WHERE slug=$1`, [SLUG]);
    const disabled = await agent();
    const { pendingPublication: _marker, ...mapping } = await binding();

    await restart().scan();
    expect(await agent()).toEqual(disabled);
    expect(await binding()).toEqual(mapping);
  });

  it('never deletes a marked mapping while its definition is absent, and finishes the registration once approved again', async() => {
    // The mapping is written, then the registration transaction fails before the row exists.
    f.beforeTransaction = async() => { f.beforeTransaction = undefined; f.failSettingsWrites = 1; throw new Error('connection terminated') };
    await expect(restart().scan()).rejects.toThrow();
    const marked = await binding();
    expect(marked.pendingPublication).toEqual({ fileId: FILE, versionId: V1 });
    expect(await agent()).toBeUndefined();

    approved = false;
    await restart().scan();
    expect(await binding()).toEqual(marked);
    expect(await agent()).toBeUndefined();

    approved = true;
    await restart().scan();
    const registered = await agent();
    expect(registered).toMatchObject({ id: marked.agentId, use_case_file_id: FILE, use_case_version_id: V1 });
    await restart().scan();
    const { pendingPublication: _marker, ...settled } = marked;
    expect(await binding()).toEqual(settled);
  });

  it('settles a marker only on the exact entry it was written with', async() => {
    const marked = { editToken: 'package-token', agentId: 'agent-package', revision: 1, connections: { grok: 'grok-oauth-account' }, candidates: [{ provider: 'grok', model: 'grok-4.7' }], pendingPublication: { fileId: FILE, versionId: V1 } };
    await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, marked as any));
    expect(await withWorkerBindingWrite(() => modelRouter.clearPendingPublication(SLUG, 'agent-package', { editToken: 'other-token', revision: 1 }))).toBe(false);
    expect(await withWorkerBindingWrite(() => modelRouter.clearPendingPublication(SLUG, 'agent-package', { editToken: 'package-token', revision: 2 }))).toBe(false);
    expect(await withWorkerBindingWrite(() => modelRouter.clearPendingPublication(SLUG, 'agent-other', { editToken: 'package-token', revision: 1 }))).toBe(false);
    expect(await binding()).toEqual(marked);
    expect(await withWorkerBindingWrite(() => modelRouter.clearPendingPublication(SLUG, 'agent-package', { editToken: 'package-token', revision: 1 }))).toBe(true);
    const { pendingPublication: _marker, ...settled } = marked;
    expect(await binding()).toEqual(settled);
  });

  describe('a marked mapping from a different publication of the same agent', () => {
    /** V1 (grok-4.7) wrote its marked mapping, then its registration and the cleanup both failed. */
    async function interruptedV1() {
      f.beforeTransaction = async() => { f.beforeTransaction = undefined; f.failSettingsWrites = 1; throw new Error('connection terminated') };
      await expect(restart().scan()).rejects.toThrow();
      const stale = await binding();
      expect(stale).toMatchObject({ agentId: AGENT_ID, candidates: [{ provider: 'grok', model: 'grok-4.7' }], pendingPublication: { fileId: FILE, versionId: V1 } });
      expect(await agent()).toBeUndefined();
      return stale;
    }
    /** The same root file is then published and approved at V2 with a different model. */
    const approveV2 = () => { version = V2; MANIFEST = manifestFor('grok-4.5') };

    it('is never adopted for the new version, across restarts, and nothing is registered until the owner resolves it', async() => {
      const stale = await interruptedV1();
      approveV2();
      await expect(restart().scan()).rejects.toThrow('activation will retry');
      await expect(restart().scan()).rejects.toThrow('activation will retry');
      expect(audits.at(-1)).toContain('another publication');
      expect(await agent()).toBeUndefined();
      expect(await binding()).toEqual(stale);

      // The owner removes the stale mapping in AI Models (exact compare-and-set); V2 then registers with its own pin.
      await withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(SLUG, AGENT_ID, { token: stale.editToken, revision: stale.revision }, null));
      await restart().scan();
      expect(await agent()).toMatchObject({ id: AGENT_ID, use_case_version_id: V2 });
      await restart().scan();
      expect(await binding()).toMatchObject({ agentId: AGENT_ID, candidates: [{ provider: 'grok', model: 'grok-4.5' }] });
      expect(await binding()).not.toHaveProperty('pendingPublication');
    });

    it('is rejected inside the serialized mapping write when it appears after the pre-check', async() => {
      approveV2();
      const v1Mapping = { editToken: 'v1-token', agentId: AGENT_ID, revision: 1, connections: { grok: 'grok-oauth-account' }, candidates: [{ provider: 'grok', model: 'grok-4.7' }], pendingPublication: { fileId: FILE, versionId: V1 } };
      // A concurrent V1 registration lands its marked mapping between the pre-check and this write.
      vi.mocked(workerModelRouting.validateSubscriptionCandidates).mockImplementationOnce(async() => {
        await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, v1Mapping as any));
        return { grok: 'grok-oauth-account' };
      });
      await expect(restart().scan()).rejects.toThrow('activation will retry');
      expect(audits.at(-1)).toContain('another publication');
      expect(await binding()).toEqual(v1Mapping);
      expect(await agent()).toBeUndefined();
    });

    it('keeps the marker and the mapping, and fails visibly, when the registered definition has different provenance', async() => {
      // The definition with the same id is already registered at V2; the leftover mapping is marked for V1.
      approveV2();
      await f.db.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled,source_kind,use_case_file_id,use_case_version_id) VALUES ($1,$2,'QA chat Grok','production',TRUE,'local',$3,$4)`, [AGENT_ID, SLUG, FILE, V2]);
      const v1Mapping = { editToken: 'v1-token', agentId: AGENT_ID, revision: 1, connections: { grok: 'grok-oauth-account' }, candidates: [{ provider: 'grok', model: 'grok-4.7' }], pendingPublication: { fileId: FILE, versionId: V1 } };
      await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, v1Mapping as any));
      const row = await agent();

      await expect(restart().scan()).rejects.toThrow(/different publication/);
      await expect(restart().scan()).rejects.toThrow(/different publication/);
      expect(await binding()).toEqual(v1Mapping);
      expect(await agent()).toEqual(row);

      // An explicit owner edit drops the marker and resolves it; the owner's mapping is then left alone.
      await withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(SLUG, AGENT_ID, { token: 'v1-token', revision: 1 },
        { editToken: 'owner-token', connections: { grok: 'grok-oauth-account' }, candidates: [{ provider: 'grok', model: 'grok-4.5' }] }));
      const owner = await binding();
      await restart().scan();
      expect(await binding()).toEqual(owner);
      expect(await agent()).toEqual(row);
    });

    it('the serialized mapping write itself never adopts a marked mapping for another publication', async() => {
      const mapping = (extra: Record<string, unknown> = {}) => ({ editToken: 'token', agentId: AGENT_ID, revision: 1, connections: {}, candidates: [{ provider: 'grok', model: 'grok-4.5' }], ...extra }) as any;
      const v1 = mapping({ editToken: 'v1-token', candidates: [{ provider: 'grok', model: 'grok-4.7' }], pendingPublication: { fileId: FILE, versionId: V1 } });
      await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, v1));
      const add = (binding: any) => withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, binding));
      await expect(add(mapping({ pendingPublication: { fileId: FILE, versionId: V2 } }))).rejects.toThrow(/another publication/);
      await expect(add(mapping({ pendingPublication: { fileId: 'a1b2c3d4-0000-4000-8000-000000000001', versionId: V1 } }))).rejects.toThrow(/another publication/);
      await expect(add(mapping())).rejects.toThrow(/another publication/);
      expect(await add(mapping({ pendingPublication: { fileId: FILE, versionId: V1 } }))).toBe(false);
      expect(await binding()).toEqual(v1);
    });

    it('blocks an approved V2 without a model pin from registering over the interrupted V1 mapping', async() => {
      const stale = await interruptedV1();
      version = V2; MANIFEST = manifestFor();
      await expect(restart().scan()).rejects.toThrow('activation will retry');
      expect(audits.at(-1)).toContain('another publication');
      expect(await agent()).toBeUndefined();
      expect(await binding()).toEqual(stale);
      await expect(workerModelRouting.newRoute(SLUG)).resolves.toBeUndefined();
    });

    it('a same-id definition with other provenance cannot launch the marked mapping or fall back to another model', async() => {
      await f.db.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled,source_kind,use_case_file_id,use_case_version_id) VALUES ($1,$2,'QA chat Grok','production',TRUE,'local',$3,$4)`, [AGENT_ID, SLUG, FILE, V2]);
      await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, { editToken: 'v1-token', agentId: AGENT_ID, revision: 1, connections: {}, candidates: [{ provider: 'grok', model: 'grok-4.7' }], pendingPublication: { fileId: FILE, versionId: V1 } } as any));
      await expect(workerModelRouting.newRoute(SLUG)).rejects.toThrow(/still being registered/);
    });

    it('a marker that raced in after the pre-check, before the unpinned insert, still cannot run', async() => {
      version = V2; MANIFEST = manifestFor();
      // The concurrent V1 mapping lands between eligibility and the definition insert.
      f.beforeTransaction = async() => {
        f.beforeTransaction = undefined;
        await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, { editToken: 'v1-token', agentId: AGENT_ID, revision: 1, connections: {}, candidates: [{ provider: 'grok', model: 'grok-4.7' }], pendingPublication: { fileId: FILE, versionId: V1 } } as any));
      };
      await restart().scan();
      expect(await agent()).toMatchObject({ id: AGENT_ID, use_case_version_id: V2 });
      await expect(workerModelRouting.newRoute(SLUG)).rejects.toThrow(/still being registered/);
      // The next scan reports the mismatch for the owner instead of settling it.
      await expect(restart().scan()).rejects.toThrow(/different publication/);
      await expect(workerModelRouting.newRoute(SLUG)).rejects.toThrow(/still being registered/);
    });

    it('still reuses an unmarked owner-saved mapping for the same agent', async() => {
      const owner = { editToken: 'owner-token', agentId: AGENT_ID, revision: 3, connections: { grok: 'grok-oauth-account' }, candidates: [{ provider: 'grok', model: 'grok-4.5' }] };
      await withWorkerBindingWrite(() => modelRouter.addWorkerBindingIfAbsent(SLUG, owner as any));
      await restart().scan();
      expect(await agent()).toMatchObject({ id: AGENT_ID, use_case_version_id: V1 });
      expect(await binding()).toEqual(owner);
    });
  });

  it('a committed registration whose marker could not be cleared waits instead of running, then works once settled', async() => {
    f.beforeTransaction = async() => { f.beforeTransaction = undefined; f.failSettingsWrites = 1 };
    await restart().scan().catch(() => undefined);
    expect(await binding()).toHaveProperty('pendingPublication');
    await expect(workerModelRouting.newRoute(SLUG)).rejects.toThrow(/still being registered/);
    await restart().scan();
    await expect(workerModelRouting.newRoute(SLUG)).resolves.toMatchObject({ agentId: AGENT_ID, candidates: [{ provider: 'grok', model: 'grok-4.7' }] });
  });

  it('leaves an ordinary successful registration with a plain mapping', async() => {
    await restart().scan();
    const registered = await agent();
    expect(await binding()).toMatchObject({ agentId: registered.id, revision: 1, candidates: [{ provider: 'grok', model: 'grok-4.7' }] });
    expect(await binding()).not.toHaveProperty('pendingPublication');
  });
});
