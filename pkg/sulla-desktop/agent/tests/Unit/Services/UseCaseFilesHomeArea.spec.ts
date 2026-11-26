// SPDX-License-Identifier: GPL-2.0-or-later
// Producer/consumer contract for the Use Cases home collection. The Files service's real
// HomeSystemFileRepository.systemAreas SQL runs on PGlite and its exact output is what the scanner
// receives from /v1/local/system-areas. The scanner's agent SQL runs on a second PGlite database.
// Faked boundaries: Files HTTP (listing, preview, approvals) and the owner model-mapping store.
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeSystemFileRepository } from '../../../../../../services/sulla-files/src/Repositories/HomeSystemFileRepository';

const f = vi.hoisted(() => ({ app: undefined as any, routes: [] as unknown[][] }));

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/agent/database/PostgresClient', () => {
  const run = async(text: string, params: any[] = []) => { const r = await f.app.query(text, params); return { rows: r.rows, rowCount: r.affectedRows ?? null } };
  return { postgresClient: {
    query:    async(text: string, params?: any[]) => (await run(text, params)).rows,
    queryOne: async(text: string, params?: any[]) => (await run(text, params)).rows[0] ?? null,
    transaction: async(work: (client: any) => Promise<unknown>) => {
      await f.app.query('BEGIN');
      try { const result = await work({ query: run }); await f.app.query('COMMIT'); return result } catch (error) { await f.app.query('ROLLBACK'); throw error }
    },
  } };
});
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: vi.fn(async() => []), uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));
vi.mock('@pkg/main/marketplace/databaseArtifacts', () => ({ readDatabaseArtifact: vi.fn(async() => { throw new Error('legacy export must not run') }) }));
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({ workerModelRouting: {
  assertReusablePublicationMapping: vi.fn(async() => undefined),
  pendingPublicationBindings: vi.fn(async() => []),
  reconcilePublishedPackageBinding: vi.fn(async(...args: unknown[]) => { if (!args[2]) return { outcome: 'unchanged' }; f.routes.push(args); return { outcome: 'written', written: { editToken: 'token', revision: 1 } } }),
  clearPendingPublication: vi.fn(async() => undefined),
  removeBindingForDefinition: vi.fn(async() => undefined),
} }));

import { up as renameBuiltins } from '@pkg/agent/database/migrations/0174_builtin_agent_identities';
import { SullaUseCaseFiles } from '@pkg/main/sullaUseCaseFiles';

import type { PoolClient } from 'pg';

const OWNER = 'owner-principal';
const HOME = '11111111-1111-4111-8111-111111111111';
const LOGS = '22222222-2222-4222-8222-222222222222';
const FILE = '6c6bc5bd-80ee-492e-b090-1b2f2735dbc0';
const V1 = '99786748-b1a9-4765-bfe7-5bd05e0f146b';
const SLUG = 'qa-chat-grok-20261117';
const ROOT_PATH = `Use Cases/agents/${ SLUG }/agent.yaml`;

// The Files service tables the producer's home query reads.
const FILES_SCHEMA = `
  CREATE TABLE collections (id UUID PRIMARY KEY, owner_user_id TEXT, published BOOLEAN NOT NULL DEFAULT TRUE, legacy_source BOOLEAN NOT NULL DEFAULT FALSE,
    system_area TEXT, is_default BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE file_roots (id TEXT PRIMARY KEY, collection_id UUID);
  CREATE TABLE collection_acl (collection_id UUID, principal_type TEXT, principal_id TEXT, role TEXT);
`;
const APP_SCHEMA = `
  CREATE TABLE use_case_files_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), initial_export_completed_at TIMESTAMPTZ, last_scan_at TIMESTAMPTZ, last_error TEXT);
  INSERT INTO use_case_files_state(singleton, last_error) VALUES (TRUE, 'Files system areas unavailable (401)');
  CREATE TABLE agent_definitions (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
    soul_content TEXT NOT NULL DEFAULT '', allowed_tools TEXT[] NOT NULL DEFAULT '{}', skill_refs TEXT[] NOT NULL DEFAULT '{}', routine_refs TEXT[] NOT NULL DEFAULT '{}',
    model_priority JSONB NOT NULL DEFAULT '[]'::jsonb, version TEXT, status TEXT NOT NULL DEFAULT 'draft', enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb, prompt_content TEXT NOT NULL DEFAULT '', goals_content TEXT NOT NULL DEFAULT '', prompt_files JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider TEXT, model TEXT, model_slot TEXT, model_choice JSONB, agent_awareness BOOLEAN NOT NULL DEFAULT TRUE, source_kind TEXT NOT NULL DEFAULT 'local', when_to_call TEXT NOT NULL DEFAULT '', when_not_to_call TEXT NOT NULL DEFAULT '',
    send TEXT NOT NULL DEFAULT '', returns TEXT NOT NULL DEFAULT '', cost_tier TEXT, can_call TEXT[] NOT NULL DEFAULT '{}', front_door BOOLEAN,
    use_case_file_id UUID, use_case_version_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

let filesDb: PGlite;
let calls: string[] = [];
let areas: unknown[] = [];

async function files(endpoint: string, init: RequestInit = {}): Promise<Response> {
  calls.push(`${ init.method ?? 'GET' } ${ endpoint }`);
  if (endpoint === '/v1/local/system-areas') return Response.json(areas);
  if (endpoint.startsWith('/v1/files?')) {
    const query = new URLSearchParams(endpoint.split('?')[1]);
    return Response.json(query.get('collectionId') === HOME ? [{ id: FILE, path: ROOT_PATH, published_version_id: V1 }] : []);
  }
  if (endpoint.startsWith('/v1/files/publish-requests?')) return Response.json({ requests: [{ file_id: FILE, version_id: V1, status: 'approved', path: ROOT_PATH }] });
  if (endpoint.startsWith(`/v1/files/${ FILE }/preview`)) return new Response(`slug: ${ SLUG }\nname: QA chat Grok\nprovider: grok\nmodel: grok-4.7\nsystemPrompt: Answer MENU_AGENT_OK.\n`);
  if (endpoint === '/v1/local/system-areas/audit') return Response.json({ ok: true });
  return Response.json({ error: `unexpected ${ endpoint }` }, { status: 500 });
}

/** Exactly what GET /v1/local/system-areas returns: the producer's rows, serialized as JSON. */
async function producerResponse(): Promise<unknown[]> {
  return JSON.parse(JSON.stringify(await new HomeSystemFileRepository(filesDb as any).systemAreas(OWNER)));
}

const writes = () => calls.filter(call => !call.startsWith('GET '));
const agents = async() => (await f.app.query('SELECT slug,use_case_file_id FROM agent_definitions')).rows;

beforeAll(async() => { filesDb = new PGlite(); f.app = new PGlite() }, 60_000);
afterAll(async() => { await filesDb?.close(); await f.app?.close() });
beforeEach(async() => {
  await filesDb.exec('DROP TABLE IF EXISTS collections, file_roots, collection_acl;'); await filesDb.exec(FILES_SCHEMA);
  await f.app.exec('DROP TABLE IF EXISTS use_case_files_state, agent_definitions, agent_builtin_seed_ledger, sulla_settings, skill_definitions, workflows, function_definitions, recipe_definitions;'); await f.app.exec(APP_SCHEMA);
  calls = []; areas = []; f.routes = [];
});

async function migratedPackage(completed: boolean) {
  await f.app.exec(`
    ALTER TABLE agent_definitions ADD COLUMN is_builtin boolean DEFAULT false, ADD COLUMN builtin_hash text;
    CREATE TABLE agent_builtin_seed_ledger(slug text PRIMARY KEY);
    CREATE TABLE sulla_settings(property text PRIMARY KEY,value text);
    CREATE TABLE skill_definitions(slug text, enabled boolean, deleted_at timestamptz, updated_at timestamptz, use_case_file_id uuid, use_case_version_id uuid, frontmatter jsonb);
    CREATE TABLE workflows(id text,enabled boolean,status text,updated_at timestamptz,use_case_file_id uuid);
    CREATE TABLE function_definitions(slug text,enabled boolean,updated_at timestamptz,use_case_file_id uuid,use_case_version_id uuid);
    CREATE TABLE recipe_definitions(LIKE function_definitions);
  `);
  if (completed) await f.app.exec('UPDATE use_case_files_state SET initial_export_completed_at=now()');
  await f.app.query(`INSERT INTO agent_definitions(id,slug,name,is_builtin,use_case_file_id,use_case_version_id,status,system_prompt)
    VALUES ('original','opus-worker','Opus Worker',true,$1,$2,'production','original prompt')`, [FILE,V1]);
  await f.app.transaction((tx: PoolClient) => renameBuiltins(tx));
}

const JSON_FILE = '00000000-0000-4000-8000-000000000003';
const V2 = '00000000-0000-4000-8000-000000000002';
const folder = 'Use Cases/agents/opus-worker/';
const yamlRoot = { id: FILE, path: folder + 'agent.yaml', published_version_id: V1 };
const jsonRoot = { id: JSON_FILE, path: folder + 'agent.json', published_version_id: V2 };
const winner = JSON.stringify({ apiVersion: 'sulla/v3', kind: 'Agent', metadata: { slug: 'opus-worker', title: 'Opus Worker' }, spec: { prompt: 'JSON prompt' } });
const readRows = async() => (await f.app.query('SELECT id,slug,system_prompt,use_case_file_id,use_case_version_id,status,enabled FROM agent_definitions ORDER BY id')).rows;
const original = { id: 'original', slug: 'advisor', system_prompt: 'original prompt', use_case_file_id: FILE, use_case_version_id: V1, status: 'production', enabled: true };
type Root = { id: string; path: string; published_version_id: string | null; deleted_at?: string };

function publication(rows: Root[] = [yamlRoot, jsonRoot], content = winner) {
  const announce = vi.fn();
  const audits: any[] = [];
  const scan = () => new SullaUseCaseFiles(async(endpoint, init) => {
    if (endpoint === '/v1/local/system-areas') return Response.json([{ id: HOME, systemArea: 'sulla' }]);
    if (endpoint.startsWith('/v1/files?')) return Response.json(rows);
    if (endpoint.startsWith('/v1/files/publish-requests?')) return Response.json({ requests: [{ file_id: JSON_FILE, version_id: V2, path: jsonRoot.path, status: 'approved' }] });
    if (endpoint === '/v1/local/system-areas/audit') { audits.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }) }
    const row = rows.find(r => endpoint.startsWith('/v1/files/' + r.id));
    if (!row) throw new Error(endpoint);
    if (endpoint.includes('/preview?')) return new Response(row.id === JSON_FILE ? content : 'slug: opus-worker\nname: Opus Worker\nsystemPrompt: YAML prompt');
    return Response.json(row);
  }, { announce }).scan();
  return { scan, announce, audits };
}

describe('publication ownership after the identity migration', () => {
  it('defers a new approved winner beside the owned root while export is pending', async() => {
    await migratedPackage(false);
    const { scan, announce } = publication();
    for (let pass = 0; pass < 2; pass++) {
      await scan();
      expect(await readRows()).toEqual([original]);
      expect((await f.app.query('SELECT initial_export_completed_at FROM use_case_files_state')).rows[0].initial_export_completed_at).toBeNull();
    }
    expect(f.routes).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
  });

  it('projects the new winner onto the original ID after export is completed', async() => {
    await migratedPackage(true);
    const { scan, announce } = publication();
    for (let pass = 0; pass < 2; pass++) {
      await scan();
      expect(await readRows()).toEqual([{ ...original, system_prompt: 'JSON prompt', use_case_file_id: JSON_FILE, use_case_version_id: V2 }]);
      expect(announce).not.toHaveBeenCalledWith(expect.objectContaining({ change: 'deleted' }));
    }
  });

  it('audits the invalid winner without archiving the last good row', async() => {
    await migratedPackage(true);
    const { scan, announce, audits } = publication(undefined, '{');
    await expect(scan()).rejects.toThrow(/retry/);
    expect(await readRows()).toEqual([original]);
    expect(audits).toContainEqual(expect.objectContaining({ fileId: JSON_FILE, versionId: V2 }));
    expect(announce).not.toHaveBeenCalled();
  });

  it.each([true, false])('does not resurrect an editor-removed owner (completed: %s)', async(completed) => {
    await migratedPackage(completed);
    await f.app.exec(`UPDATE agent_definitions SET config='{"removedFromEditor":true}',status='archive',enabled=false`);
    const { scan, announce } = publication();
    await scan();
    expect(await readRows()).toEqual([{ ...original, status: 'archive', enabled: false }]);
    expect(announce).not.toHaveBeenCalled();
  });

  it.each([true, false])('defers a secondary-root match if the legacy row owns the winner (completed: %s)', async(completed) => {
    await migratedPackage(completed);
    await f.app.query(`INSERT INTO agent_definitions(id,slug,name,use_case_file_id,use_case_version_id,status,enabled)
      VALUES ('second','opus-worker','Other',$1,$2,'archive',false)`, [JSON_FILE, V2]);
    const before = await readRows();
    const { scan, announce } = publication();
    if (completed) await expect(scan()).rejects.toThrow(/retry/);
    else await scan();
    expect(await readRows()).toEqual(before);
    expect(announce).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'unrelated root', row: { ...yamlRoot, id: HOME } },
    { label: 'nested decoy', row: { ...yamlRoot, path: folder + 'nested/agent.yaml' } },
    { label: 'draft', row: { ...yamlRoot, published_version_id: null } },
    { label: 'deleted root', row: { ...yamlRoot, deleted_at: '2026-01-01' } },
  ])('keeps ordinary folder behavior without an owned live root: $label', async({ row }) => {
    await migratedPackage(true);
    await publication([row, jsonRoot]).scan();
    const rows = await readRows();
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ ...original, enabled: false, status: 'archive' });
    expect(rows).toContainEqual(expect.objectContaining({ slug: 'opus-worker', enabled: true, use_case_file_id: JSON_FILE, system_prompt: 'JSON prompt' }));
  });

  it('archives the original when its package is genuinely gone', async() => {
    await migratedPackage(true);
    const { scan, announce } = publication([]);
    await scan();
    expect(await readRows()).toEqual([{ ...original, enabled: false, status: 'archive' }]);
    expect(announce).toHaveBeenCalledWith({ type: 'agent', slug: 'advisor', change: 'deleted' });
  });
});

describe('Use Cases home collection from the Files system-areas producer', () => {
  it('scans the owner home the producer tags as the sulla area and registers the approved agent there', async() => {
    await filesDb.query(`INSERT INTO collections(id,owner_user_id,system_area,is_default) VALUES ($1,$2,NULL,TRUE),($3,$2,'logs',FALSE)`, [HOME, OWNER, LOGS]);
    await filesDb.query(`INSERT INTO file_roots(id,collection_id) VALUES ('default',$1)`, [HOME]);
    areas = await producerResponse();
    expect(areas).toEqual([{ id: HOME, systemArea: 'sulla' }]);

    await new SullaUseCaseFiles(files).scan();
    expect(calls.some(call => call.startsWith('GET /v1/files?') && call.includes(`collectionId=${ HOME }`))).toBe(true);
    expect(await agents()).toEqual([{ slug: SLUG, use_case_file_id: FILE }]);
    expect(f.routes).toHaveLength(1);
  });

  it('keeps the migrated built-in active across a scan and a legacy-path republish', async() => {
    await migratedPackage(true);
    let version = V1;
    const scanner = new SullaUseCaseFiles(async(endpoint) => {
      const row = { id:FILE, path:'Use Cases/agents/opus-worker/agent.yaml', published_version_id:version };
      if (endpoint === '/v1/local/system-areas') return Response.json([{ id:HOME, systemArea:'sulla' }]);
      if (endpoint.startsWith('/v1/files?')) return Response.json([row]);
      if (endpoint.startsWith(`/v1/files/${ FILE }/preview`)) return new Response(`slug: opus-worker\nname: Opus Worker\nsystemPrompt: ${ version }\n`);
      if (endpoint === `/v1/files/${ FILE }`) return Response.json(row);
      throw new Error(endpoint);
    });
    for (version of [V1, '00000000-0000-4000-8000-000000000002']) {
      await scanner.scan();
      expect((await f.app.query('SELECT id,slug,name,enabled,status,system_prompt FROM agent_definitions')).rows)
        .toEqual([{ id:'original',slug:'advisor',name:'Advisor',enabled:true,status:'production',system_prompt:version }]);
    }
  });

  it.each([
    ['no owner home', async() => producerResponse()],
    ['only another system area', async() => [{ id: LOGS, systemArea: 'logs' }]],
    ['an untagged area', async() => [{ id: HOME, systemArea: null }]],
  ])('reports %s visibly and writes nothing', async(_label, response) => {
    areas = await response();
    await expect(new SullaUseCaseFiles(files).scan()).rejects.toThrow('no owner home area');
    expect(calls).toEqual(['GET /v1/local/system-areas']);
    expect(writes()).toEqual([]);
    expect(await agents()).toEqual([]);
    expect(f.routes).toEqual([]);
    expect((await f.app.query('SELECT initial_export_completed_at,last_error FROM use_case_files_state')).rows[0]).toEqual({ initial_export_completed_at: null, last_error: expect.stringContaining('no owner home area') });
  });
});
