// SPDX-License-Identifier: GPL-2.0-or-later
// Use Cases scan before the one-time migration (initial_export_completed_at NULL), on real SQL
// (PGlite). The agent INSERT/ON CONFLICT and every guard query run unchanged. Faked boundaries:
// the Files HTTP API (listing, previews, approved publish requests), the owner model-mapping store,
// memory packs, the legacy export reader and Files-removal reconciliation (both recorded so the
// test can prove they never run while the migration is pending).
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  db: undefined as any,
  owned: new Map<string, { agentId: string; editToken: string; pendingPublication?: { fileId: string; versionId: string } }>(),
  routes: [] as any[][],
  removed: [] as any[][],
  memory: [] as string[],
  exportReads: 0,
  removalReads: 0,
  beforeTransaction: undefined as undefined | (() => Promise<void>),
  cleanupFailures: 0,
}));

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
import Logging from '@pkg/utils/logging';
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
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({
  installMemoryPackForSkill: vi.fn(async() => { f.memory.push('install') }),
  listPacks: vi.fn(async() => { f.memory.push('list'); return [] }),
  uninstallPack: vi.fn(async() => { f.memory.push('uninstall') }),
}));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn(async() => { f.memory.push('skills-invalidate') }) } }));
vi.mock('@pkg/agent/database/repositories/UseCaseRemovalRepository', () => ({ UseCaseRemovalRepository: class { async listRemoved() { f.removalReads++; return [] } } }));
vi.mock('@pkg/main/marketplace/databaseArtifacts', () => ({ readDatabaseArtifact: vi.fn(async() => { f.exportReads++; throw new Error('legacy export must not run') }) }));
// Owner mapping store with the real ownership rule: a different agent's mapping is preserved.
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({ workerModelRouting: {
  initializeBindingForPublishedPackage: vi.fn(async(slug: string, agentId: string, candidates: unknown[], pendingPublication?: { fileId: string; versionId: string }) => {
    f.routes.push([slug, agentId, candidates]);
    const owner = f.owned.get(slug);
    if (owner && owner.agentId !== agentId) throw new Error('A different agent already owns this worker mapping; it was preserved.');
    if (owner) return { created: false };
    const binding = { editToken: `token-${ agentId }`, revision: 1 };
    f.owned.set(slug, { agentId, editToken: binding.editToken, ...(pendingPublication ? { pendingPublication } : {}) });
    return { created: true, binding };
  }),
  assertReusablePublicationMapping: vi.fn(async(slug: string, agentId: string, requested: { fileId: string; versionId: string }) => {
    const marker = f.owned.get(slug)?.agentId === agentId ? f.owned.get(slug)?.pendingPublication : undefined;
    if (marker && (marker.fileId !== requested.fileId || marker.versionId !== requested.versionId)) throw new Error('An unsettled package model mapping from another publication exists; it was preserved for the owner to resolve in AI Models.');
  }),
  pendingPublicationBindings: vi.fn(async() => [...f.owned].filter(([, entry]) => entry.pendingPublication)
    .map(([slug, entry]) => ({ slug, agentId: entry.agentId, editToken: entry.editToken, revision: 1, ...entry.pendingPublication! }))),
  clearPendingPublication: vi.fn(async(slug: string, agentId: string, created: { editToken: string }) => {
    const owner = f.owned.get(slug);
    if (owner?.agentId === agentId && owner.editToken === created.editToken) delete owner.pendingPublication;
  }),
  removeBindingForDefinition: vi.fn(async(slug: string, agentId: string, created?: { editToken: string }) => {
    f.removed.push([slug, agentId, created]);
    if (f.cleanupFailures > 0) { f.cleanupFailures--; throw new Error('settings store temporarily unavailable') }
    const owner = f.owned.get(slug);
    if (owner?.agentId === agentId && (!created || owner.editToken === created.editToken)) f.owned.delete(slug);
  }),
} }));

import { SullaUseCaseFiles } from '@pkg/main/sullaUseCaseFiles';

const SCHEMA = `
  CREATE TABLE use_case_files_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), initial_export_completed_at TIMESTAMPTZ, last_scan_at TIMESTAMPTZ, last_error TEXT);
  INSERT INTO use_case_files_state(singleton, last_error) VALUES (TRUE, 'Files system areas unavailable (401)');
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
  CREATE TABLE skill_definitions (slug TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ, frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
    use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE workflows (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', enabled BOOLEAN NOT NULL DEFAULT TRUE, use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE function_definitions (slug TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE recipe_definitions (slug TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

const SLUG = 'qa-chat-grok-20261117';
const FILE = '6c6bc5bd-80ee-492e-b090-1b2f2735dbc0';
const V1 = '99786748-b1a9-4765-bfe7-5bd05e0f146b';
const V2 = '0f6e1a52-6d7b-4c1e-9a43-2f1d8b0c7e11';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER_V = 'a1b2c3d4-0000-4000-8000-000000000002';

type Row = { id: string; path: string; published_version_id: string | null };
let rows: Row[] = [];
let approvals: { file_id: string; version_id: string; status: string; path: string }[] = [];
let contents = new Map<string, string>();
let calls: { endpoint: string; method: string }[] = [];
let approvalStatus = 200;

const manifest = (slug: string, prompt = 'Answer MENU_AGENT_OK.') => `slug: ${ slug }\nname: QA chat Grok\nprovider: grok\nmodel: grok-4.7\nsystemPrompt: ${ prompt }\n`;
function publish(id: string, path: string, versionId: string | null, body = '') {
  rows = [...rows.filter(row => row.id !== id), { id, path, published_version_id: versionId }];
  if (versionId) contents.set(`${ id }:${ versionId }`, body);
}
function approve(fileId: string, versionId: string, path: string) { approvals.push({ file_id: fileId, version_id: versionId, status: 'approved', path }) }

async function files(endpoint: string, init: RequestInit = {}): Promise<Response> {
  calls.push({ endpoint, method: init.method ?? 'GET' });
  if (endpoint === '/v1/local/system-areas') return Response.json([{ id: 'home', systemArea: 'sulla' }]);
  if (endpoint.startsWith('/v1/files?')) return Response.json(rows);
  if (endpoint.startsWith('/v1/files/publish-requests?')) {
    if (approvalStatus !== 200) return Response.json({ error: 'unavailable' }, { status: approvalStatus });
    const query = new URLSearchParams(endpoint.split('?')[1]);
    return Response.json({ requests: approvals.filter(item => item.status === query.get('status') && item.file_id === query.get('fileId')) });
  }
  const preview = /^\/v1\/files\/([^/]+)\/preview\?versionId=(.+)$/.exec(endpoint);
  if (preview) return new Response(contents.get(`${ decodeURIComponent(preview[1]) }:${ decodeURIComponent(preview[2]) }`) ?? '', { status: 200 });
  if (endpoint === '/v1/local/system-areas/audit') return Response.json({ ok: true });
  return Response.json({ error: `unexpected ${ endpoint }` }, { status: 500 });
}

const ROOT_PATH = `Use Cases/agents/${ SLUG }/agent.yaml`;
const agent = async(slug = SLUG) => (await f.db.query('SELECT id,slug,enabled,status,model,provider,source_kind,system_prompt,use_case_file_id,use_case_version_id,config FROM agent_definitions WHERE slug=$1', [slug])).rows[0];
const snapshot = async() => {
  const out: Record<string, unknown[]> = {};
  for (const table of ['agent_definitions', 'skill_definitions', 'workflows', 'function_definitions', 'recipe_definitions']) out[table] = (await f.db.query(`SELECT * FROM ${ table } ORDER BY 1`)).rows;
  return out;
};
const writesToFiles = () => calls.filter(call => /\/v1\/local\/system-areas\/(ingest|move)|\/publish(\?|$)/.test(call.endpoint) || (call.method !== 'GET' && !call.endpoint.endsWith('/audit')));

/** Unrelated catalog state that must survive a pending-phase scan byte for byte. */
async function seedCatalog() {
  await f.db.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled,model,provider,config,source_kind) VALUES
    ('agent-disabled','owner-disabled','Disabled','draft',FALSE,'grok-4.5','grok','{"keep":true}','local'),
    ('agent-enabled','owner-enabled','Enabled','production',TRUE,'claude-opus-5-5','anthropic','{}','local'),
    ('agent-builtin','builtin-helper','Builtin','production',TRUE,NULL,NULL,'{}','marketplace'),
    ('agent-linked','linked-agent','Linked','production',TRUE,NULL,'grok','{}','local')`);
  await f.db.query(`UPDATE agent_definitions SET use_case_file_id=$1,use_case_version_id=$2 WHERE slug='linked-agent'`, [OTHER, OTHER_V]);
  await f.db.query(`INSERT INTO skill_definitions(slug,enabled,frontmatter,use_case_file_id,use_case_version_id) VALUES ('memory-skill',TRUE,'{"memory_pack":"true"}',$1,$2)`, [OTHER, OTHER_V]);
  await f.db.query(`INSERT INTO workflows(id,status,enabled,use_case_file_id) VALUES ('draft-flow','draft',FALSE,NULL),('linked-flow','production',TRUE,$1)`, [OTHER]);
}

beforeAll(async() => { f.db = new PGlite() }, 60_000);
afterAll(async() => { await f.db?.close() });
beforeEach(async() => {
  await f.db.exec('DROP TABLE IF EXISTS use_case_files_state, agent_definitions, skill_definitions, workflows, function_definitions, recipe_definitions;');
  await f.db.exec(SCHEMA);
  rows = []; approvals = []; contents = new Map(); calls = []; approvalStatus = 200;
  vi.mocked(Logging.background.info).mockClear();
  f.owned.clear(); f.routes = []; f.removed = []; f.memory = []; f.exportReads = 0; f.removalReads = 0; f.beforeTransaction = undefined; f.cleanupFailures = 0;
});

describe('Use Cases scan while the one-time migration is pending', () => {
  it('registers a new agent from its human-approved exact root anchor, and nothing else changes', async() => {
    await seedCatalog();
    const before = await snapshot();
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    approve(FILE, V1, ROOT_PATH);

    await new SullaUseCaseFiles(files).scan();

    const registered = await agent();
    expect(registered).toMatchObject({ enabled: true, status: 'production', source_kind: 'local', provider: 'grok', model: null, system_prompt: 'Answer MENU_AGENT_OK.', use_case_file_id: FILE, use_case_version_id: V1 });
    expect(f.routes).toEqual([[SLUG, registered.id, [{ provider: 'grok', model: 'grok-4.7' }]]]);
    expect(f.owned.get(SLUG)?.agentId).toBe(registered.id);
    const after = await snapshot();
    expect({ ...after, agent_definitions: after.agent_definitions.filter((row: any) => row.slug !== SLUG) }).toEqual(before);
    // No export, move, ingestion, publication, reconciliation or memory work.
    expect(writesToFiles()).toEqual([]);
    expect(f.exportReads).toBe(0);
    expect(f.removalReads).toBe(0);
    expect(f.memory).toEqual([]);
    expect((await f.db.query('SELECT initial_export_completed_at,last_scan_at,last_error FROM use_case_files_state')).rows[0]).toEqual({ initial_export_completed_at: null, last_scan_at: null, last_error: null });
  });

  it('never re-enables the agent or reinstalls a cleared mapping for the same version, across rescans and restarts', async() => {
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    approve(FILE, V1, ROOT_PATH);
    const service = new SullaUseCaseFiles(files);
    await service.scan();
    // The owner disables the agent, clears its model mapping and edits its settings.
    await f.db.query(`UPDATE agent_definitions SET enabled=FALSE,status='draft',model=NULL,config='{"owner":"edit"}' WHERE slug=$1`, [SLUG]);
    f.owned.delete(SLUG);
    const edited = await agent();

    await service.scan();
    await new SullaUseCaseFiles(files).scan();
    await new SullaUseCaseFiles(files).scan();

    expect(await agent()).toEqual(edited);
    expect(f.routes).toHaveLength(1);
    expect(f.owned.has(SLUG)).toBe(false);
    // The indexed version is recognised as already registered, not re-qualified or reported as waiting.
    expect(calls.filter(call => call.endpoint.startsWith('/v1/files/publish-requests'))).toHaveLength(1);
    expect(vi.mocked(Logging.background.info).mock.calls.flat().join('\n')).not.toContain(SLUG);
  });

  it.each([
    ['an unapproved direct publication', () => publish(FILE, ROOT_PATH, V1, manifest(SLUG))],
    ['an approval for an earlier version', () => { publish(FILE, ROOT_PATH, V2, manifest(SLUG)); approve(FILE, V1, ROOT_PATH) }],
    ['an approval for a different file', () => { publish(FILE, ROOT_PATH, V1, manifest(SLUG)); approve(OTHER, V1, ROOT_PATH) }],
    ['an approved nested duplicate with no root anchor', () => { publish(OTHER, `Use Cases/agents/${ SLUG }/nested/agent.yaml`, OTHER_V, manifest(SLUG)); approve(OTHER, OTHER_V, `Use Cases/agents/${ SLUG }/nested/agent.yaml`) }],
    ['an approved nested duplicate beside an unpublished root anchor', () => { publish(FILE, ROOT_PATH, null); publish(OTHER, `Use Cases/agents/${ SLUG }/nested/agent.yaml`, OTHER_V, manifest(SLUG)); approve(OTHER, OTHER_V, `Use Cases/agents/${ SLUG }/nested/agent.yaml`) }],
    ['an approved non-agent package', () => { publish(OTHER, 'Use Cases/skills/new-skill/SKILL.md', OTHER_V, '---\nslug: new-skill\n---\n'); approve(OTHER, OTHER_V, 'Use Cases/skills/new-skill/SKILL.md') }],
  ])('defers %s without any definition or mapping write', async(_label, arrange) => {
    await seedCatalog();
    const before = await snapshot();
    arrange();
    await new SullaUseCaseFiles(files).scan();
    expect(await snapshot()).toEqual(before);
    expect(f.routes).toEqual([]);
    expect(writesToFiles()).toEqual([]);
    expect(f.memory).toEqual([]);
  });

  it('uses the exact root anchor even when an approved nested duplicate is also published', async() => {
    // Listed before the root file, so a suffix match would pick it.
    publish(OTHER, `Use Cases/agents/${ SLUG }/nested/agent.yaml`, OTHER_V, manifest(SLUG, 'Nested prompt.'));
    approve(OTHER, OTHER_V, `Use Cases/agents/${ SLUG }/nested/agent.yaml`);
    publish(FILE, ROOT_PATH, V1, manifest(SLUG, 'Root prompt.'));
    approve(FILE, V1, ROOT_PATH);
    await new SullaUseCaseFiles(files).scan();
    expect(await agent()).toMatchObject({ system_prompt: 'Root prompt.', use_case_file_id: FILE, use_case_version_id: V1 });
  });

  it.each([
    ['an unlinked local agent', `INSERT INTO agent_definitions(id,slug,name,status,enabled,model,source_kind) VALUES ('agent-mine','${ SLUG }','Mine','draft',FALSE,'grok-4.5','local')`],
    ['a protected marketplace agent', `INSERT INTO agent_definitions(id,slug,name,status,enabled,source_kind) VALUES ('agent-mine','${ SLUG }','Builtin','production',TRUE,'marketplace')`],
    ['an agent linked to a different anchor', `INSERT INTO agent_definitions(id,slug,name,status,enabled,source_kind,use_case_file_id,use_case_version_id) VALUES ('agent-mine','${ SLUG }','Other','production',TRUE,'local','${ OTHER }','${ OTHER_V }')`],
    ['the same anchor at an older version', `INSERT INTO agent_definitions(id,slug,name,status,enabled,source_kind,use_case_file_id,use_case_version_id) VALUES ('agent-mine','${ SLUG }','Older','draft',FALSE,'local','${ FILE }','${ V2 }')`],
  ])('leaves %s with the same slug untouched, before any mapping is written', async(_label, seed) => {
    await f.db.query(seed);
    const before = await agent();
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    approve(FILE, V1, ROOT_PATH);
    await new SullaUseCaseFiles(files).scan();
    expect(await agent()).toEqual(before);
    expect(f.routes).toEqual([]);
  });

  it('preserves a definition inserted concurrently after the eligibility check, and removes only its own new mapping', async() => {
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    approve(FILE, V1, ROOT_PATH);
    f.beforeTransaction = async() => {
      f.beforeTransaction = undefined;
      await f.db.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled,model,source_kind) VALUES ('agent-racer','${ SLUG }','Racer','draft',FALSE,'grok-4.5','local')`);
    };
    const racer = { id: 'agent-racer', slug: SLUG, enabled: false, status: 'draft', model: 'grok-4.5' };
    await expect(new SullaUseCaseFiles(files).scan()).rejects.toThrow('activation will retry');
    expect(await agent()).toMatchObject({ ...racer, use_case_file_id: null });
    const created = f.routes[0][1];
    expect(f.removed).toEqual([[SLUG, created, { editToken: `token-${ created }`, revision: 1 }]]);
    expect(f.owned.has(SLUG)).toBe(false);
    // A later scan sees the racer and leaves it alone.
    await new SullaUseCaseFiles(files).scan();
    expect(await agent()).toMatchObject(racer);
    expect(f.routes).toHaveLength(1);
  });

  it('never overwrites a same-identity registration that won the race and was already edited by its owner', async() => {
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    approve(FILE, V1, ROOT_PATH);
    const id = `agent-${ createHash('sha256').update(`sulla-use-case-agent\0${ SLUG }\0${ FILE }`).digest('hex').slice(0, 32) }`;
    f.beforeTransaction = async() => {
      f.beforeTransaction = undefined;
      await f.db.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled,model,source_kind) VALUES ($1,'${ SLUG }','Owner edited','draft',FALSE,NULL,'local')`, [id]);
    };
    await expect(new SullaUseCaseFiles(files).scan()).rejects.toThrow('activation will retry');
    expect(await agent()).toMatchObject({ id, enabled: false, status: 'draft', system_prompt: '', use_case_file_id: null });
  });

  it("keeps another agent's existing mapping and writes no definition", async() => {
    f.owned.set(SLUG, { agentId: 'agent-other-owner', editToken: 'owner-token' });
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    approve(FILE, V1, ROOT_PATH);
    await expect(new SullaUseCaseFiles(files).scan()).rejects.toThrow('activation will retry');
    expect(await agent()).toBeUndefined();
    expect(f.owned.get(SLUG)).toEqual({ agentId: 'agent-other-owner', editToken: 'owner-token' });
  });

  it('fails closed before any write when approvals cannot be read', async() => {
    await seedCatalog();
    const before = await snapshot();
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    approve(FILE, V1, ROOT_PATH);
    approvalStatus = 503;
    await expect(new SullaUseCaseFiles(files).scan()).rejects.toThrow('publication approvals unavailable (503)');
    expect(await snapshot()).toEqual(before);
    expect(f.routes).toEqual([]);
    expect((await f.db.query('SELECT last_error FROM use_case_files_state')).rows[0].last_error).toContain('503');
  });

  it('registers a package approved after an earlier scan deferred it, in the same running service with an unchanged listing', async() => {
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    const service = new SullaUseCaseFiles(files);
    await service.scan();
    expect(await agent()).toBeUndefined();

    approve(FILE, V1, ROOT_PATH);
    await service.scan();
    expect(await agent()).toMatchObject({ use_case_file_id: FILE, use_case_version_id: V1, enabled: true });
    expect(f.routes).toHaveLength(1);

    // Once registered, the same version is settled: no further approval reads or registrations.
    const approvalReads = () => calls.filter(call => call.endpoint.startsWith('/v1/files/publish-requests')).length;
    const settled = approvalReads();
    await service.scan();
    await service.scan();
    expect(approvalReads()).toBe(settled);
    expect(f.routes).toHaveLength(1);
  });

  describe('when removing its own new mapping fails after losing the registration race', () => {
    const racer = { id: 'agent-racer', slug: SLUG, enabled: false, status: 'draft', model: 'grok-4.5' };
    async function loseRace() {
      publish(FILE, ROOT_PATH, V1, manifest(SLUG));
      approve(FILE, V1, ROOT_PATH);
      f.beforeTransaction = async() => {
        f.beforeTransaction = undefined;
        await f.db.query(`INSERT INTO agent_definitions(id,slug,name,status,enabled,model,source_kind) VALUES ('agent-racer','${ SLUG }','Racer','draft',FALSE,'grok-4.5','local')`);
      };
      f.cleanupFailures = 1;
      const service = new SullaUseCaseFiles(files);
      await expect(service.scan()).rejects.toThrow(/mapping could not be removed/);
      const created = f.routes[0][1];
      expect(f.owned.get(SLUG)?.agentId).toBe(created);
      return { service, created };
    }

    it('reports the failure and removes exactly that mapping on the next scan', async() => {
      const { service, created } = await loseRace();
      await service.scan();
      expect(f.owned.has(SLUG)).toBe(false);
      expect(f.removed.at(-1)).toEqual([SLUG, created, { editToken: `token-${ created }`, revision: 1 }]);
      expect(await agent()).toMatchObject(racer);
    });

    it('keeps failing visibly while the removal keeps failing', async() => {
      const { service } = await loseRace();
      f.cleanupFailures = 2;
      await expect(service.scan()).rejects.toThrow('settings store temporarily unavailable');
      await expect(service.scan()).rejects.toThrow('settings store temporarily unavailable');
      expect(f.owned.has(SLUG)).toBe(true);
      await service.scan();
      expect(f.owned.has(SLUG)).toBe(false);
    });

    it("never removes a newer mapping the owner saved in the meantime", async() => {
      const { service } = await loseRace();
      f.owned.set(SLUG, { agentId: 'agent-racer', editToken: 'owner-token' });
      await service.scan();
      expect(f.owned.get(SLUG)).toEqual({ agentId: 'agent-racer', editToken: 'owner-token' });
      expect(await agent()).toMatchObject(racer);
    });
  });

  it('runs completed-mode reconciliation when the migration completes, even with an identical listing', async() => {
    publish(FILE, ROOT_PATH, V1, manifest(SLUG));
    const service = new SullaUseCaseFiles(files);
    await service.scan();
    expect(await agent()).toBeUndefined();
    expect(f.removalReads).toBe(0);

    await f.db.query('UPDATE use_case_files_state SET initial_export_completed_at=NOW()');
    await service.scan();
    expect(await agent()).toMatchObject({ enabled: true, use_case_file_id: FILE, use_case_version_id: V1 });
    expect(f.removalReads).toBe(1);
    expect(f.memory).toEqual(['list', 'skills-invalidate']);
  });
});
