// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  storedAgent: undefined as { id:string; source_kind:string; use_case_file_id:string|null } | undefined,
  failRegistrations: 1,
  insertParams: [] as any[][],
  insertSql: [] as string[],
  initializedRoutes: [] as any[][],
  routeCreated: false,
  removedRoutes: [] as any[][],
}));

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: {
  queryOne: vi.fn(async(sql: string) => sql.includes('initial_export_completed_at')
    ? { initial_export_completed_at: 'done' }
    : f.storedAgent),
  query: vi.fn(async() => []),
  transaction: vi.fn(async(work: (client: any) => Promise<unknown>) => work({ query: async(sql: string, params: any[] = []) => {
    if (!sql.includes('INSERT INTO agent_definitions')) return { rows: [] };
    f.insertParams.push(params);
    f.insertSql.push(sql);
    if (f.failRegistrations > 0) {
      f.failRegistrations--;
      throw new Error('temporary projection failure');
    }
    const [id, slug, , , , , , , , , , , , , , , , , , , , fileId] = params;
    f.storedAgent = { id: String(id), source_kind: 'local', use_case_file_id: String(fileId) };
    // node-postgres returns rows for an upsert only when the statement asks for them.
    return { rows: /\bRETURNING\s+id\b/i.test(sql) ? [{ id: String(id) }] : [] };
  } })),
} }));
vi.mock('@pkg/agent/database/repositories/UseCaseRemovalRepository', () => ({
  UseCaseRemovalRepository: class { async listRemoved() { return [] } },
}));
vi.mock('@pkg/agent/services/SkillDefinitionService', () => ({ hashSkillContent: vi.fn(), parseSkillMarkdown: vi.fn() }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: async() => [], uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({ workerModelRouting: {
  initializeBindingForPublishedPackage: vi.fn(async(...args: any[]) => {
    f.initializedRoutes.push(args);
    if (f.routeCreated) return { created: false };
    f.routeCreated = true;
    return { created: true, binding: { editToken: 'created-token', revision: 1 } };
  }),
  removeBindingForDefinition: vi.fn(async(...args: any[]) => {
    f.removedRoutes.push(args);
    f.routeCreated = false;
  }),
} }));

import { SullaUseCaseFiles } from '@pkg/main/sullaUseCaseFiles';

const packageRows = [{ id: 'grok-file', path: 'Use Cases/agents/grok-pr-reviewer/agent.json', published_version_id: 'published-v1' }];
const packageText = JSON.stringify({
  apiVersion: 'sulla/v3', kind: 'Agent', manifestVersion: 1,
  metadata: { slug: 'grok-pr-reviewer', title: 'Grok PR Reviewer', description: 'Reviews PRs.', version: '1.0.0' },
  spec: { agentAwareness: false, provider: 'grok', model: 'grok-4.7', prompt: 'Review the approved pull request head.', tools: [], skills: [], routines: [], config: {}, promptFiles: {} },
});
let currentPackageText = packageText;

function response(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200 }); }

function request(endpoint: string): Promise<Response> {
  if (endpoint === '/v1/local/system-areas') return Promise.resolve(response([{ id: 'home', systemArea: 'sulla' }]));
  if (endpoint.startsWith('/v1/files?')) return Promise.resolve(response(packageRows));
  if (endpoint.startsWith('/v1/files/grok-file/preview')) return Promise.resolve(new Response(currentPackageText, { status: 200 }));
  if (endpoint === '/v1/local/system-areas/audit') return Promise.resolve(response({ ok: true }));
  throw new Error(`Unexpected Files request ${ endpoint }`);
}

describe('published legacy agent registration retry', () => {
  beforeEach(() => {
    f.storedAgent = undefined;
    f.failRegistrations = 1;
    f.insertParams = [];
    f.insertSql = [];
    currentPackageText = packageText;
    f.initializedRoutes = [];
    f.routeCreated = false;
    f.removedRoutes = [];
  });

  it('routes the exact approved model before registration and retries a failed projection without caching success', async() => {
    const service = new SullaUseCaseFiles(request);
    await expect(service.scan()).rejects.toThrow('activation will retry');
    expect(f.insertParams).toHaveLength(1);
    expect(f.initializedRoutes).toHaveLength(1);
    expect(f.initializedRoutes[0][0]).toBe('grok-pr-reviewer');
    expect(f.initializedRoutes[0][2]).toEqual([{ provider: 'grok', model: 'grok-4.7' }]);
    expect(f.initializedRoutes[0][1]).toBe(f.insertParams[0][0]);
    expect(f.insertParams[0][1]).toBe('grok-pr-reviewer');
    expect(f.insertParams[0][12]).toBe('grok');
    expect(f.insertParams[0][23]).toBe(false);
    // The rollback carries the exact identity it created, never just the agent id.
    expect(f.removedRoutes).toEqual([[ 'grok-pr-reviewer', f.insertParams[0][0], { editToken: 'created-token', revision: 1 } ]]);
    expect(f.storedAgent).toBeUndefined();

    await service.scan();
    expect(f.insertParams).toHaveLength(2);
    expect(f.insertParams[1][0]).toBe(f.insertParams[0][0]);
    expect(f.initializedRoutes).toHaveLength(2);
    expect(f.initializedRoutes[1][1]).toBe(f.initializedRoutes[0][1]);
    expect(f.storedAgent).toMatchObject({ id: f.insertParams[0][0], source_kind: 'local', use_case_file_id: 'grok-file' });

    await service.scan();
    expect(f.insertParams).toHaveLength(2);
  });

  it('leaves omitted awareness unset so SQL defaults new agents and preserves existing user settings', async() => {
    // risk: every package rescan runs the upsert, which can silently undo a user's opt-out.
    currentPackageText = JSON.stringify({
      apiVersion: 'sulla/v3', kind: 'Agent', manifestVersion: 1,
      metadata: { slug: 'grok-pr-reviewer', title: 'Grok PR Reviewer', description: 'Reviews PRs.', version: '1.0.0' },
      spec: { provider: 'grok', model: 'grok-4.7', prompt: 'Review the approved pull request head.', tools: [], skills: [], routines: [], config: {}, promptFiles: {} },
    });
    f.failRegistrations = 0;

    await new SullaUseCaseFiles(request).scan();

    expect(f.insertParams).toHaveLength(1);
    expect(f.insertParams[0][23]).toBeNull();
    expect(f.insertSql[0]).toContain('COALESCE($24,TRUE)');
    expect(f.insertSql[0]).toContain('agent_awareness=COALESCE($24,agent_definitions.agent_awareness)');
  });
});
