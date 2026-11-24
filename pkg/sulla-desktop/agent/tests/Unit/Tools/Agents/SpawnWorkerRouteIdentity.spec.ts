// SPDX-License-Identifier: GPL-2.0-or-later
import '../../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toolDecisionPort } from '@pkg/agent/tools/toolDecisionPort';
import { agentToolManifests } from '@pkg/agent/tools/agents/manifests';
import { SpawnAgentWorker, taskGraphAgentChannel } from '@pkg/agent/tools/agents/spawn_agent';

const f = vi.hoisted(() => ({ captured: [] as string[], resolve: vi.fn(async() => [{ provider: 'codex', model: 'gpt-6-luna' }]) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: async(slug: string) => ['luna', 'pinned', 'pending'].includes(slug) ? { id: `${ slug }-id`, slug, model_choice: slug === 'pinned' ? { mode: 'pin', provider: 'codex', model: 'gpt-6-pinned' } : undefined } : null } }));
vi.mock('@pkg/agent/services/AgentLaunchPauseService', () => ({ agentLaunchPauseService: { isPaused: () => Promise.resolve(false) } }));
vi.mock('@pkg/agent/languagemodels/modelRouter', () => ({ modelRouter: { resolve: f.resolve } }));
// Owner mappings exist for the parent manager and for one named role; launch overrides must bypass them.
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({
  installWorkerRoute: vi.fn(),
  workerModelRouting: {
    newRoute: vi.fn(async(slug: string) => {
      f.captured.push(slug);
      if (slug === 'pending') throw new Error('mapping is still being registered');
      return ['mapped-manager', 'luna'].includes(slug) ? { version: 1, slug, agentId: `${ slug }-id`, revision: 1, selected: 0, candidates: [{ provider: 'codex', model: `${ slug }-mapped` }] } : undefined;
    }),
    subscriptionConnections: vi.fn(async() => ({ grok: 'oauth' })),
  },
}));

function harness() {
  vi.spyOn(toolDecisionPort.resolve(), 'requiresApproval').mockResolvedValue(false);
  const worker = new SpawnAgentWorker(); worker.name = 'spawn_agent';
  worker.setState({ metadata: { subAgentDepth: 0, wsChannel: 'mapped-manager' } } as any);
  worker.schemaDef = agentToolManifests.find(m => m.name === 'spawn_agent')!.schemaDef!;
  const launch = vi.spyOn(worker as any, 'launchHidden').mockResolvedValue({ successBoolean: true, responseString: 'accepted', result: {} });
  const routeFor = (task: unknown) => (worker as any).workerRoutes.get(task);
  const decisionFor = (task: unknown) => (worker as any).modelDecisions.get(task);
  return { worker, launch, routeFor, decisionFor };
}
afterEach(() => { vi.restoreAllMocks(); f.captured = []; f.resolve.mockClear() });

describe('spawn_agent worker mapping identity', () => {
  it('uses an explicit launch model without reading or attaching a saved mapping', async() => {
    const { worker, launch, routeFor } = harness();
    const result = await worker.call({ tasks: [{ prompt: 'synthetic work', model: 'gpt-6-luna' }] });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(f.captured).toEqual([]);
    const [task] = launch.mock.calls[0][0] as any[];
    // risk: explicit model silently loses to a saved worker mapping.
    expect(routeFor(task)).toBeUndefined();
    expect(task.model).toBe('gpt-6-luna');
    expect((worker as any).modelDecisions.get(task)).toMatchObject({ step: 'override', requested: { provider: 'codex', model: 'gpt-6-luna' } });
    expect(taskGraphAgentChannel(task, 'mapped-manager')).toBe('sulla-desktop');
  });

  it('lets a pending mapping registration coexist with a valid explicit override', async() => {
    const { worker, launch, routeFor } = harness();
    const result = await worker.call({ tasks: [{ prompt: 'synthetic work', agentId: 'pending', model: 'gpt-6-luna' }] });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(f.captured).toEqual([]);
    expect(routeFor((launch.mock.calls[0][0] as any[])[0])).toBeUndefined();
  });

  it.each([
    { provider: 'claude-code' },
    { model: 'unknown-model-id' },
  ])('rejects an override that cannot be an exact provider/model pin before job creation: %o', async override => {
    const { worker, launch } = harness();
    const result = await worker.call({ tasks: [{ prompt: 'synthetic work', ...override }] });
    expect(result.success).toBe(false);
    expect(result.responseString).toContain('Requested model');
    expect(launch).not.toHaveBeenCalled();
  });

  it('uses the programmed agent pin when there is no explicit override', async() => {
    const { worker, launch, decisionFor, routeFor } = harness();
    const result = await worker.call({ tasks: [{ prompt: 'synthetic work', agentId: 'pinned' }] });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const [task] = launch.mock.calls[0][0] as any[];
    expect(routeFor(task)).toBeUndefined();
    expect(decisionFor(task)).toMatchObject({ step: 'agent-pin', requested: { provider: 'codex', model: 'gpt-6-pinned' } });
  });

  it('does not replace a named role mapping when there is no override', async() => {
    const { worker, launch, routeFor } = harness();
    await worker.call({ tasks: [{ prompt: 'synthetic work', agentId: 'luna' }] });
    expect(f.captured).toEqual(['luna']);
    expect(routeFor((launch.mock.calls[0][0] as any[])[0])).toMatchObject({ slug: 'luna', agentId: 'luna-id' });
  });

  it('uses the parent channel mapping only when the child runs as the parent channel', async() => {
    const { worker, launch, routeFor } = harness();
    await worker.call({ tasks: [{ prompt: 'synthetic work' }] });
    expect(f.captured).toEqual(['mapped-manager']);
    const [task] = launch.mock.calls[0][0] as any[];
    expect(routeFor(task)).toMatchObject({ slug: 'mapped-manager' });
    expect(taskGraphAgentChannel(task, 'mapped-manager')).toBe('mapped-manager');
  });
});
