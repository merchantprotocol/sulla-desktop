// SPDX-License-Identifier: GPL-2.0-or-later
// A failed package activation may roll back only the exact mapping it created. An owner edit
// saved while the activation's SQL was still running must survive that rollback.
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ store: new Map<string, any>(), sqlGate: null as null | Promise<void>, sqlEntered: false, sqlFails: true }));
vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { codex: {}, 'claude-code': {}, grok: {} } }));
vi.mock('../../../services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: vi.fn() } }));
vi.mock('../../../languagemodels/credentials/ClaudeCredentialResolver', () => ({ claudeCredentialResolver: { resolve: vi.fn() } }));
vi.mock('../../../nodes/ThreadStateStore', () => ({ saveThreadState: vi.fn() }));
vi.mock('../../../services/IntegrationService', () => ({ getIntegrationService: () => ({
  getActiveAccountId: async(provider: string) => (provider === 'grok' ? 'oauth' : 'codex-subscription'),
  getAccounts: async(provider: string) => [{ account_id: provider === 'grok' ? 'oauth' : 'codex-subscription', connected: true }],
}) }));
// An existing enabled local agent with no owner mapping yet; its registration SQL stalls, then fails.
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: {
  queryOne: vi.fn(async(sql: string) => sql.includes('initial_export_completed_at') ? { initial_export_completed_at: 'done' } : { id: 'agent-existing', source_kind: 'local', use_case_file_id: null }),
  query: vi.fn(async() => []),
  transaction: vi.fn(async(work: (client: any) => Promise<unknown>) => work({ query: async(sql: string) => {
    if (!sql.includes('INSERT INTO agent_definitions')) return { rows: [] };
    f.sqlEntered = true;
    await f.sqlGate;
    if (f.sqlFails) throw new Error('temporary projection failure');
    return { rows: [{ id: 'agent-existing' }] };
  } })),
} }));
vi.mock('@pkg/agent/database/repositories/UseCaseRemovalRepository', () => ({ UseCaseRemovalRepository: class { async listRemoved() { return [] } } }));
vi.mock('@pkg/agent/services/SkillDefinitionService', () => ({ hashSkillContent: vi.fn(), parseSkillMarkdown: vi.fn() }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), listPacks: async() => [], uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/database/registry/SkillsRegistry', () => ({ skillsRegistry: { invalidate: vi.fn() } }));

import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { modelRouter, recommendedState } from '../../../languagemodels/modelRouter';
import { assertWorkerBindingsUnchanged, withWorkerBindingWrite } from '../../../languagemodels/workerBindingAuthority';
import { SullaUseCaseFiles } from '@pkg/main/sullaUseCaseFiles';

const SLUG = 'grok-pr-reviewer';
const rows = [{ id: '11111111-1111-4111-8111-111111111111', path: `Use Cases/agents/${ SLUG }/agent.yaml`, published_version_id: '22222222-2222-4222-8222-222222222222' }];
const packageText = `slug: ${ SLUG }\nname: Grok PR Reviewer\nprovider: grok\nmodel: grok-4.7\nsystemPrompt: Review the approved pull request head.\n`;
function files(endpoint: string): Promise<Response> {
  if (endpoint === '/v1/local/system-areas') return Promise.resolve(Response.json([{ id: 'home', systemArea: 'sulla' }]));
  if (endpoint.startsWith('/v1/files?')) return Promise.resolve(Response.json(rows));
  if (endpoint.startsWith(`/v1/files/${ rows[0].id }/preview`)) return Promise.resolve(new Response(packageText, { status: 200 }));
  if (endpoint === '/v1/local/system-areas/audit') return Promise.resolve(Response.json({ ok: true }));
  throw new Error(`Unexpected Files request ${ endpoint }`);
}
const binding = () => f.store.get('modelRouting')?.workerBindings?.[SLUG];

beforeEach(() => {
  f.store.clear(); f.sqlGate = null; f.sqlEntered = false; f.sqlFails = true;
  vi.restoreAllMocks();
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async(key, fallback) => structuredClone(f.store.get(key) ?? fallback));
  vi.spyOn(SullaSettingsModel, 'set').mockImplementation(async(key, value) => {
    if (key === 'modelRouting') assertWorkerBindingsUnchanged(f.store.get(key)?.workerBindings, (value as any)?.workerBindings);
    f.store.set(key, structuredClone(value));
  });
  vi.spyOn(modelRouter, 'providerInfo').mockResolvedValue([
    { id: 'grok', connected: true, models: [{ id: 'grok-4.7' }] },
    { id: 'codex', connected: true, models: [{ id: 'gpt-6-luna', efforts: [{ id: 'max' }] }] },
  ] as any);
  f.store.set('modelRouting', recommendedState());
});

describe('failed package activation rollback ownership', () => {
  it('preserves a newer owner edit for the same agent saved while activation SQL was running', async() => {
    let release!: () => void; f.sqlGate = new Promise(resolve => { release = resolve });
    const scan = new SullaUseCaseFiles(files).scan();
    await vi.waitFor(() => expect(f.sqlEntered).toBe(true));
    const created = structuredClone(binding());
    expect(created).toMatchObject({ agentId: 'agent-existing', revision: 1, candidates: [{ provider: 'grok', model: 'grok-4.7' }] });

    // Owner opens the newly created mapping in AI Models and saves a different model (same agent id).
    await withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(SLUG, 'agent-existing', { token: created.editToken, revision: 1 }, {
      editToken: 'owner-edit', connections: { codex: 'codex-subscription' }, candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }],
    }));
    const ownerEdit = structuredClone(binding());

    release();
    await expect(scan).rejects.toThrow('activation will retry');
    expect(binding()).toEqual(ownerEdit);
    expect(ownerEdit).toMatchObject({ editToken: 'owner-edit', revision: 2, agentId: 'agent-existing' });
  });

  it('still removes its own untouched mapping when activation fails', async() => {
    await expect(new SullaUseCaseFiles(files).scan()).rejects.toThrow('activation will retry');
    expect(binding()).toBeUndefined();
  });

  it('keeps the mapping it created when activation succeeds', async() => {
    f.sqlFails = false;
    await new SullaUseCaseFiles(files).scan();
    expect(binding()).toMatchObject({ agentId: 'agent-existing', revision: 1 });
  });
});
