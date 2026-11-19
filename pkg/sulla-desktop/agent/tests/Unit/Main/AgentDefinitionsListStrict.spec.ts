// SPDX-License-Identifier: GPL-2.0-or-later
// agent-definitions:list during a database outage. The production list function runs through a
// real DatabaseReadGuard (test timings) whose classifier sees an actual ECONNREFUSED to the Sulla
// Postgres port. Legacy callers keep the guarded [] answer; a strict caller is told the catalog is
// unavailable instead of receiving a false empty list. Only the definitions read is faked.
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableClassifier } from '@pkg/agent/database/DatabaseAvailability';
import { agentDefinitionService } from '@pkg/agent/services/AgentDefinitionService';
import { DatabaseReadGuard } from '@pkg/main/DatabaseReadGuard';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false, on: vi.fn(), once: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() }, webContents: { getAllWebContents: () => [] }, safeStorage: {} }));

import { listAgentDefinitions } from '@pkg/main/agentsIpc';

const DB_PORT = 30116;
const refused = () => Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${ DB_PORT }`), { code: 'ECONNREFUSED', port: DB_PORT, address: '127.0.0.1' });
const row = (slug: string) => ({ id: `id-${ slug }`, slug, name: slug, description: '', provider: 'grok', model: null, model_slot: 'primary', model_choice: null, prompt_content: 'p',
  source_kind: 'local', marketplace_version: null, status: 'production', enabled: true, run_location: 'vm', when_to_call: '', when_not_to_call: '', send: '', returns: '',
  cost_tier: null, can_call: [], is_builtin: false, front_door: null, updated_at: '2026-11-17T10:00:00Z', config: {} });

let guard: DatabaseReadGuard;
beforeEach(() => {
  guard = new DatabaseReadGuard({
    classifier: new DatabaseUnavailableClassifier(DB_PORT),
    probe: async() => { throw refused() },
    isShuttingDown: () => false,
    notifyAvailable: () => undefined,
    logger: { info: () => undefined },
    sleep: async(ms) => { if (ms >= 100) await new Promise(() => undefined) },
    retryDelaysMs: [1, 1],
    recoveryMinMs: 100,
  });
  vi.spyOn(DatabaseReadGuard, 'shared').mockReturnValue(guard);
});
afterEach(() => { vi.restoreAllMocks() });

describe('agent-definitions:list during a database outage', () => {
  it('still answers legacy callers with the guarded empty list and starts recovery', async() => {
    vi.spyOn(agentDefinitionService, 'list').mockRejectedValue(refused());
    await expect(listAgentDefinitions()).resolves.toEqual([]);
    expect(guard.isDatabaseDown).toBe(true);
  });

  it('tells a strict caller the catalog is unavailable instead of returning an empty list, and still starts recovery', async() => {
    const list = vi.spyOn(agentDefinitionService, 'list').mockRejectedValue(refused());
    await expect(listAgentDefinitions({ strict: true })).rejects.toThrow(/temporarily unavailable/);
    expect(list).toHaveBeenCalledTimes(3);
    expect(guard.isDatabaseDown).toBe(true);
  });

  it('returns a real empty catalog to a strict caller as empty', async() => {
    vi.spyOn(agentDefinitionService, 'list').mockResolvedValue([]);
    await expect(listAgentDefinitions({ strict: true })).resolves.toEqual([]);
  });

  it('maps rows identically for strict and legacy callers', async() => {
    vi.spyOn(agentDefinitionService, 'list').mockResolvedValue([row('qa-chat-grok-20261117'), { ...row('old'), status: 'archive' }] as any);
    const strict = await listAgentDefinitions({ strict: true });
    expect(strict).toEqual(await listAgentDefinitions());
    expect(strict.map(agent => agent.slug)).toEqual(['qa-chat-grok-20261117']);
  });

  it('rethrows a non-availability error to every caller', async() => {
    vi.spyOn(agentDefinitionService, 'list').mockRejectedValue(new Error('column "slug" does not exist'));
    await expect(listAgentDefinitions()).rejects.toThrow('column "slug" does not exist');
    await expect(listAgentDefinitions({ strict: true })).rejects.toThrow('column "slug" does not exist');
  });
});
