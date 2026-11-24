// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETIRED_CODING_MANAGER_SLUGS } from '@pkg/agent/builtinAgents/index';

const f = vi.hoisted(() => ({
  rows: [] as { id: string; path: string; published_version_id: string }[],
  agentRows: {} as Record<string, { enabled: boolean; status: string; use_case_file_id: string | null }>,
  initialExportComplete: true,
  transactions: 0,
  queryCalls: [] as { sql: string; params: unknown[] }[],
  requested: [] as string[],
}));

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: {
    queryOne: vi.fn(async(sql: string) => sql.includes('initial_export_completed_at')
      ? { initial_export_completed_at: f.initialExportComplete ? 'completed' : null }
      : null),
    query: vi.fn(async(sql: string, params: unknown[] = []) => {
      f.queryCalls.push({ sql, params });
      if (sql.startsWith("SELECT 'agent' AS type,slug")) return [];
      if (sql.startsWith('UPDATE agent_definitions SET enabled=FALSE,status=\'archive\'')) {
        const [retiredSlugs, activeSlugs] = params as [string[], string[]];
        for (const [slug, row] of Object.entries(f.agentRows)) {
          if (retiredSlugs.includes(slug) || (row.use_case_file_id !== null && !activeSlugs.includes(slug))) {
            row.enabled = false;
            row.status = 'archive';
          }
        }
      }
      return [];
    }),
    transaction: vi.fn(async() => { f.transactions++; return { rows: [] } }),
  },
}));
vi.mock('@pkg/agent/database/repositories/UseCaseRemovalRepository', () => ({
  UseCaseRemovalRepository: class { async listRemoved() { return [] } },
}));
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({ workerModelRouting: { pendingPublicationBindings: vi.fn(async() => []) } }));
vi.mock('@pkg/agent/services/SkillDefinitionService', () => ({ hashSkillContent: vi.fn(), parseSkillMarkdown: vi.fn() }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: async() => [], uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));

import { SullaUseCaseFiles } from '@pkg/main/sullaUseCaseFiles';

const retiredSlugs = RETIRED_CODING_MANAGER_SLUGS;
const files = retiredSlugs.map((slug, index) => ({
  id: `file-${ index }`,
  path: `Use Cases/agents/${ slug }/agent.json`,
  published_version_id: `version-${ index }`,
}));

function response(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200 }); }

function request(endpoint: string): Promise<Response> {
  f.requested.push(endpoint);
  if (endpoint === '/v1/local/system-areas') return Promise.resolve(response([{ id: 'home', systemArea: 'sulla' }]));
  if (endpoint.startsWith('/v1/files?')) return Promise.resolve(response(f.rows));
  if (endpoint === '/v1/local/system-areas/audit') return Promise.resolve(response({ ok: true }));
  throw new Error(`Unexpected Files request ${ endpoint }`);
}

describe('retired Coding Managers in Files Use Case sync', () => {
  beforeEach(() => {
    f.rows = files;
    f.agentRows = {
      'coding-manager-sol':  { enabled: true, status: 'production', use_case_file_id: 'old-sol-file' },
      'coding-manager-grok': { enabled: true, status: 'production', use_case_file_id: 'old-grok-file' },
      'coding-manager-gpt':  { enabled: true, status: 'production', use_case_file_id: null },
      'coding-manager':      { enabled: true, status: 'production', use_case_file_id: null },
    };
    f.initialExportComplete = true;
    f.transactions = 0;
    f.queryCalls = [];
    f.requested = [];
  });

  it('archives retired rows regardless of Files linkage and skips their published packages', async() => {
    // risk: a stale Files package recreates/re-enables a retired agent or leaves an unlinked row active
    const service = new SullaUseCaseFiles(request);
    await service.scan();

    for (const slug of retiredSlugs) expect(f.agentRows[slug]).toMatchObject({ enabled: false, status: 'archive' });
    expect(f.agentRows['coding-manager']).toMatchObject({ enabled: true, status: 'production' });
    expect(f.transactions).toBe(0);
    expect(f.requested.some(path => path.includes('/preview?'))).toBe(false);
    expect(f.queryCalls.find(({ sql }) => sql.startsWith('UPDATE agent_definitions'))?.params[0]).toEqual(retiredSlugs);
  });

  it('does not register a retired slug from the pre-migration approved-publication path', async() => {
    // risk: a one-time first-run sync bypasses the normal Files reconciliation guard
    f.initialExportComplete = false;
    const service = new SullaUseCaseFiles(request);
    await service.scan();

    expect(f.transactions).toBe(0);
    expect(f.requested.some(path => path.includes('/publish-requests?'))).toBe(false);
    expect(f.queryCalls.some(({ sql }) => sql.includes('INSERT INTO agent_definitions'))).toBe(false);
  });
});
