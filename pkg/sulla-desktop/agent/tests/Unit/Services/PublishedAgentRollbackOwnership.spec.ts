// SPDX-License-Identifier: GPL-2.0-or-later
// Projection commits the definition and binding together. A concurrent owner save survives
// a failed projection, and an owner save ahead of projection makes its observed mapping stale.
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

import { postgresClient } from '../../../database/PostgresClient';
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
  if (endpoint === `/v1/files/${ rows[0].id }`) return Promise.resolve(Response.json(rows[0]));
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
  vi.spyOn(SullaSettingsModel, 'projectModelRouting').mockImplementation(async project => {
    const previous = structuredClone(f.store.get('modelRouting'));
    const next = await postgresClient.transaction(client => project(client, previous));
    assertWorkerBindingsUnchanged(previous?.workerBindings, (next as typeof previous)?.workerBindings);
    f.store.set('modelRouting', structuredClone(next));
  });
  vi.spyOn(modelRouter, 'providerInfo').mockResolvedValue([
    { id: 'grok', connected: true, models: [{ id: 'grok-4.7' }] },
    { id: 'codex', connected: true, models: [{ id: 'gpt-6-luna', efforts: [{ id: 'max' }] }] },
  ] as any);
  f.store.set('modelRouting', recommendedState());
});

describe('failed package activation rollback ownership', () => {
  const ownerSave = () => withWorkerBindingWrite(() => modelRouter.replaceWorkerBinding(SLUG, 'agent-existing', { token: '', revision: 0 }, {
    editToken: 'owner-edit', connections: { codex: 'codex-subscription' }, candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }],
  }));

  it('keeps an uncommitted mapping invisible and preserves the owner save queued during failed projection', async() => {
    let release!: () => void;
    f.sqlGate = new Promise(resolve => { release = resolve });
    const scan = new SullaUseCaseFiles(files).scan();
    const failed = expect(scan).rejects.toThrow('activation will retry');
    try {
      await vi.waitFor(() => expect(f.sqlEntered).toBe(true));
      expect(binding()).toBeUndefined();
      const ownerWrite = ownerSave();
      expect(binding()).toBeUndefined();
      release();
      await failed;
      await ownerWrite;
      expect(binding()).toMatchObject({ editToken: 'owner-edit', revision: 1, agentId: 'agent-existing', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }] });
      expect(binding()).not.toHaveProperty('filePublication');
    } finally {
      release();
    }
  });

  it('rejects a stale mapping write when the owner saves during provider validation', async() => {
    const providerInfo = await modelRouter.providerInfo();
    let release!: () => void;
    let validating = false;
    const catalogGate = new Promise<void>(resolve => { release = resolve });
    vi.mocked(modelRouter.providerInfo).mockImplementationOnce(async() => {
      validating = true;
      await catalogGate;
      return providerInfo;
    });
    const scan = new SullaUseCaseFiles(files).scan();
    const failed = expect(scan).rejects.toThrow('activation will retry');
    try {
      await vi.waitFor(() => expect(validating).toBe(true));
      await ownerSave();
      const owner = structuredClone(binding());
      release();
      await failed;
      expect(f.sqlEntered).toBe(false);
      expect(binding()).toEqual(owner);
    } finally {
      release();
    }
  });

  it('keeps an untouched mapping absent when activation fails', async() => {
    await expect(new SullaUseCaseFiles(files).scan()).rejects.toThrow('activation will retry');
    expect(f.sqlEntered).toBe(true);
    expect(binding()).toBeUndefined();
  });

  it('keeps the mapping it created when activation succeeds', async() => {
    f.sqlFails = false;
    await new SullaUseCaseFiles(files).scan();
    expect(binding()).toMatchObject({ agentId: 'agent-existing', revision: 1 });
  });
});
