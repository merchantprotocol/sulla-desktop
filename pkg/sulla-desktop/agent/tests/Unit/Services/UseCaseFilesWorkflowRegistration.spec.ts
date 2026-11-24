// SPDX-License-Identifier: GPL-2.0-or-later
// Published workflow packages reach the Desktop workflows table and the scheduler, on real SQL (PGlite).
// Before the one-time migration only a brand-new workflow whose exact package-root manifest version a
// human approved is registered; nothing existing is touched. Faked boundaries: the Files HTTP API, the
// scheduler refresher (recorded), memory packs and Files-removal reconciliation.
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ db: undefined as any, beforeTransaction: undefined as undefined | (() => Promise<void>) }));

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
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: vi.fn(async() => []), uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));
vi.mock('@pkg/agent/database/repositories/UseCaseRemovalRepository', () => ({ UseCaseRemovalRepository: class { async listRemoved() { return [] } } }));
vi.mock('@pkg/main/marketplace/databaseArtifacts', () => ({ readDatabaseArtifact: vi.fn(async() => { throw new Error('legacy export must not run') }) }));
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({ workerModelRouting: { pendingPublicationBindings: vi.fn(async() => []) } }));

import { SullaUseCaseFiles, type WorkflowScheduleRefresher } from '@pkg/main/sullaUseCaseFiles';

const SCHEMA = `
  CREATE TABLE use_case_files_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), initial_export_completed_at TIMESTAMPTZ, last_scan_at TIMESTAMPTZ, last_error TEXT);
  INSERT INTO use_case_files_state(singleton) VALUES (TRUE);
  CREATE TABLE agent_definitions (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, enabled BOOLEAN NOT NULL DEFAULT TRUE, status TEXT NOT NULL DEFAULT 'draft', use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE skill_definitions (slug TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ, frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb, use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', version TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','production','archive')),
    definition JSONB NOT NULL DEFAULT '{}'::jsonb, enabled BOOLEAN NOT NULL DEFAULT TRUE, source_kind TEXT NOT NULL DEFAULT 'user', use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE function_definitions (slug TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE recipe_definitions (slug TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE, use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

const SLUG = 'facebook-group-approvals';
const ROOT_PATH = `Use Cases/workflows/${ SLUG }/workflow.yaml`;
const SCRIPT_PATH = `Use Cases/workflows/${ SLUG }/fb_group_sync.py`;
const FILE = '6c6bc5bd-80ee-492e-b090-1b2f2735dbc0';
const SCRIPT = '7d7cc6ce-91ff-4a3f-8c1a-2c3f3846ecd1';
const V1 = '99786748-b1a9-4765-bfe7-5bd05e0f146b';
const V2 = '0f6e1a52-6d7b-4c1e-9a43-2f1d8b0c7e11';
const SV = 'a1b2c3d4-0000-4000-8000-000000000002';

const manifest = (extra = '', edges = 'edges:\n  - { id: e1, source: trigger, target: sync }\n') => `id: ${ SLUG }\nname: "Facebook group approvals (all groups)"\nversion: "1"\n${ extra }nodes:
  - { id: trigger, type: workflow, data: { category: trigger, subtype: schedule, config: { frequency: hourly, intervalHours: 4 } } }
  - { id: sync, type: workflow, data: { category: action, subtype: function } }
${ edges }`;

type Row = { id: string; path: string; published_version_id: string | null };
let rows: Row[] = [];
let approvals: { file_id: string; version_id: string; status: string; path: string }[] = [];
let contents = new Map<string, string>();
let refreshes = 0;
let refreshFailures = 0;

const refresher: WorkflowScheduleRefresher = { refresh: async() => { refreshes++; if (refreshFailures > 0) { refreshFailures--; throw new Error('workflow manager unavailable') } } };
const service = () => new SullaUseCaseFiles(files, undefined, refresher);

function publish(id: string, path: string, versionId: string | null, body = '') {
  rows = [...rows.filter(row => row.id !== id), { id, path, published_version_id: versionId }];
  if (versionId) contents.set(`${ id }:${ versionId }`, body);
}
function approve(fileId: string, versionId: string, path: string) { approvals.push({ file_id: fileId, version_id: versionId, status: 'approved', path }) }
function publishApproved(body = manifest(), versionId = V1) { publish(FILE, ROOT_PATH, versionId, body); approve(FILE, versionId, ROOT_PATH) }

async function files(endpoint: string, init: RequestInit = {}): Promise<Response> {
  if (endpoint === '/v1/local/system-areas') return Response.json([{ id: 'home', systemArea: 'sulla' }]);
  if (endpoint.startsWith('/v1/files?')) return Response.json(rows);
  if (endpoint.startsWith('/v1/files/publish-requests?')) {
    const query = new URLSearchParams(endpoint.split('?')[1]);
    return Response.json({ requests: approvals.filter(item => item.status === query.get('status') && item.file_id === query.get('fileId')) });
  }
  const preview = /^\/v1\/files\/([^/]+)\/preview\?versionId=(.+)$/.exec(endpoint);
  if (preview) return new Response(contents.get(`${ decodeURIComponent(preview[1]) }:${ decodeURIComponent(preview[2]) }`) ?? '', { status: 200 });
  if (endpoint === '/v1/local/system-areas/audit' && init.method === 'POST') return Response.json({ ok: true });
  return Response.json({ error: `unexpected ${ endpoint }` }, { status: 500 });
}

const workflow = async() => (await f.db.query('SELECT id,name,status,enabled,definition,source_kind,use_case_file_id,use_case_version_id FROM workflows WHERE id=$1', [SLUG])).rows[0];
const allWorkflows = async() => (await f.db.query('SELECT * FROM workflows ORDER BY id')).rows;
const completeMigration = () => f.db.query('UPDATE use_case_files_state SET initial_export_completed_at=NOW()');

beforeAll(async() => { f.db = new PGlite() }, 60_000);
afterAll(async() => { await f.db?.close() });
beforeEach(async() => {
  await f.db.exec('DROP TABLE IF EXISTS use_case_files_state, agent_definitions, skill_definitions, workflows, function_definitions, recipe_definitions;');
  await f.db.exec(SCHEMA);
  rows = []; approvals = []; contents = new Map(); refreshes = 0; refreshFailures = 0; f.beforeTransaction = undefined;
});

describe('published workflow registration while the Use Cases migration is pending', () => {
  it('registers an approved scheduled workflow as enabled production, linked to its Files anchor, and re-arms schedules once', async() => {
    publishApproved();
    publish(SCRIPT, SCRIPT_PATH, SV, 'print("sync")');
    const scanner = service();

    await scanner.scan();
    await scanner.scan();

    const registered = await workflow();
    expect(registered).toMatchObject({ status: 'production', enabled: true, source_kind: 'user', use_case_file_id: FILE, use_case_version_id: V1, name: 'Facebook group approvals (all groups)' });
    expect(registered.definition.nodes).toHaveLength(2);
    expect(registered.definition.edges).toEqual([{ id: 'e1', source: 'trigger', target: 'sync' }]);
    expect(refreshes).toBe(1);
    // A fresh service (restart) sees the same indexed version: no rewrite and no second refresh.
    await service().scan();
    expect(refreshes).toBe(1);
  });

  it('honors an explicit enabled: false in the approved package', async() => {
    publishApproved(manifest('enabled: false\n'));
    await service().scan();
    expect(await workflow()).toMatchObject({ status: 'production', enabled: false, use_case_version_id: V1 });
  });

  it.each([
    ['an unapproved publication', () => publish(FILE, ROOT_PATH, V1, manifest())],
    ['an approval for an earlier version', () => { publish(FILE, ROOT_PATH, V2, manifest()); approve(FILE, V1, ROOT_PATH) }],
    ['a package declaring itself draft', () => publishApproved(manifest('status: draft\n'))],
    ['an approved nested manifest with no root anchor', () => { publish(FILE, `Use Cases/workflows/${ SLUG }/old/workflow.yaml`, V1, manifest()); approve(FILE, V1, `Use Cases/workflows/${ SLUG }/old/workflow.yaml`) }],
  ])('defers %s without any write or schedule refresh', async(_label, arrange) => {
    arrange();
    await service().scan();
    expect(await allWorkflows()).toEqual([]);
    expect(refreshes).toBe(0);
  });

  it('leaves an existing workflow row byte for byte, even with an approved new version', async() => {
    await f.db.query(`INSERT INTO workflows(id,name,status,enabled,definition) VALUES ($1,'Owner copy','production',FALSE,'{"nodes":[],"edges":[]}')`, [SLUG]);
    const before = await allWorkflows();
    publishApproved();
    await service().scan();
    expect(await allWorkflows()).toEqual(before);
    expect(refreshes).toBe(0);
  });

  it('rejects a package without an edges array, writes nothing and keeps retrying', async() => {
    publishApproved(manifest('', ''));
    await expect(service().scan()).rejects.toThrow('activation will retry for: workflows/facebook-group-approvals');
    expect(await allWorkflows()).toEqual([]);
    expect(refreshes).toBe(0);
  });

  it('preserves a row inserted concurrently after the eligibility check', async() => {
    publishApproved();
    f.beforeTransaction = async() => { f.beforeTransaction = undefined; await f.db.query(`INSERT INTO workflows(id,name,status,enabled) VALUES ($1,'Racer','draft',FALSE)`, [SLUG]) };
    await expect(service().scan()).rejects.toThrow('activation will retry');
    expect(await workflow()).toMatchObject({ name: 'Racer', status: 'draft', enabled: false, use_case_file_id: null });
    expect(refreshes).toBe(0);
  });

  it('retries a failed schedule refresh on the next scan, then stops', async() => {
    publishApproved();
    refreshFailures = 1;
    const scanner = service();
    await scanner.scan();
    expect(await workflow()).toMatchObject({ enabled: true });
    await scanner.scan();
    await scanner.scan();
    expect(refreshes).toBe(2);
  });
});

describe('published workflow index after the migration', () => {
  it("keeps the owner's pause across rescans of the same version, and re-arms only when something changed", async() => {
    await completeMigration();
    publishApproved();
    await service().scan();
    expect(await workflow()).toMatchObject({ status: 'production', enabled: true, use_case_version_id: V1 });
    expect(refreshes).toBe(1);

    await f.db.query('UPDATE workflows SET enabled=FALSE WHERE id=$1', [SLUG]);
    await service().scan();
    expect(await workflow()).toMatchObject({ enabled: false, use_case_version_id: V1 });
    expect(refreshes).toBe(1);

    publishApproved(manifest(), V2);
    await service().scan();
    expect(await workflow()).toMatchObject({ enabled: true, use_case_version_id: V2 });
    expect(refreshes).toBe(2);
  });

  it('re-arms once when a removed package archives its workflow, and not again after', async() => {
    await completeMigration();
    publishApproved();
    await service().scan();
    rows = [];
    await service().scan();
    expect(await workflow()).toMatchObject({ status: 'archive', enabled: false });
    expect(refreshes).toBe(2);
    await service().scan();
    expect(refreshes).toBe(2);
  });
});
