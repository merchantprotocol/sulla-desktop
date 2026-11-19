// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toolDecisionPort } from '@pkg/agent/tools/toolDecisionPort';
import { agentToolManifests } from '@pkg/agent/tools/agents/manifests';
import { SpawnAgentWorker } from '@pkg/agent/tools/agents/spawn_agent';

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn(() => Promise.resolve([{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }])) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/services/AgentLaunchPauseService', () => ({ agentLaunchPauseService: { isPaused: () => Promise.resolve(false) } }));
vi.mock('@pkg/agent/languagemodels/modelRouter', () => ({ modelRouter: { resolve } }));
// No owner worker mapping applies, so these cases exercise the explicit task pin.
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({ installWorkerRoute: vi.fn(), workerModelRouting: { newRoute: () => Promise.resolve(undefined) } }));

function harness() {
  vi.spyOn(toolDecisionPort.resolve(), 'requiresApproval').mockResolvedValue(false);
  const worker = new SpawnAgentWorker(); worker.name = 'spawn_agent'; worker.setState({ metadata: { subAgentDepth: 0, wsChannel: 'synthetic' } } as any); worker.schemaDef = agentToolManifests.find(m => m.name === 'spawn_agent')!.schemaDef!;
  const launch = vi.spyOn(worker as any, 'launchHidden').mockResolvedValue({ successBoolean: true, responseString: 'accepted', result: {} });
  return { worker, launch };
}
afterEach(() => { vi.restoreAllMocks(); resolve.mockClear() });
describe('spawn_agent effort input', () => {
  it('keeps effort through the actual tool schema instead of stripping it', async() => {
    const { worker, launch } = harness();
    const result = await worker.call({ tasks: [{ prompt: 'synthetic work', model: 'gpt-6-luna', effort: 'max' }] });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(resolve).toHaveBeenCalledWith('agents', { mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'max' });
    expect(launch.mock.calls[0][0]).toEqual([expect.objectContaining({ model: 'gpt-6-luna', provider: 'codex', effort: 'max' })]);
  });
  it('leaves an omitted effort alone and does not require the new catalog check', async() => {
    const { worker, launch } = harness();
    await worker.call({ tasks: [{ prompt: 'synthetic work', model: 'gpt-6-luna' }] });
    expect(resolve).not.toHaveBeenCalled();
    const tasks = launch.mock.calls[0][0] as { effort?: string }[];
    expect(tasks[0].effort).toBeUndefined();
  });
  it('refuses unsupported effort before launching any child', async() => {
    const { worker, launch } = harness(); resolve.mockRejectedValueOnce(new Error('Requested effort is not advertised'));
    const result = await worker.call({ tasks: [{ prompt: 'synthetic work', model: 'gpt-6-luna', effort: 'ultra' }] });
    expect(result.success).toBe(false); expect(result.result).toContain('not advertised'); expect(launch).not.toHaveBeenCalled();
  });
  it('does not report a reused default-effort job as a new max-effort run', () => {
    const { worker } = harness();
    expect(() => (worker as any).assertDeduplicatedEffort([{ model: 'gpt-6-luna', effort: 'max' }], [{ model: 'gpt-6-luna' }])).toThrow(/different model or effort/);
    expect(() => (worker as any).assertDeduplicatedEffort([{ model: 'gpt-6-luna' }], [{ model: 'gpt-6-luna', effort: 'max' }])).not.toThrow();
  });
});
