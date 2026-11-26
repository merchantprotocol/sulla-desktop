// SPDX-License-Identifier: GPL-2.0-or-later
import '../../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveLaunchModelPrecedence } from '@pkg/agent/languagemodels/modelPrecedence';
import { toolDecisionPort } from '@pkg/agent/tools/toolDecisionPort';
import { agentToolManifests } from '@pkg/agent/tools/agents/manifests';
import { SpawnAgentWorker, taskGraphAgentChannel } from '@pkg/agent/tools/agents/spawn_agent';

const f = vi.hoisted(() => ({ captured: [] as string[], bindings:{} as Record<string,any>, account:'approved', create:vi.fn(async(tasks: any[]) => ({ jobId:'existing', tasks, deduplicated:true })), resolve: vi.fn(async() => [{ provider: 'codex', model: 'gpt-6-luna' }]) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: async(slug: string) => ['luna', 'pinned', 'pending'].includes(slug) ? { id: `${ slug }-id`, slug, model_choice: slug === 'pinned' ? { mode: 'pin', provider: 'codex', model: 'gpt-6-pinned' } : undefined } : null } }));
vi.mock('@pkg/agent/services/AgentLaunchPauseService', () => ({ agentLaunchPauseService: { isPaused: () => Promise.resolve(false) } }));
vi.mock('@pkg/agent/languagemodels/modelRouter', () => ({ modelRouter: {
  resolve:f.resolve, getEditableState:async() => ({ workerBindings:f.bindings, neverUse:[] }),
  providerInfo:async() => [{ id:'codex', connected:true, models:[{ id:'listed', efforts:[{ id:'high' }] },{ id:'outside' }] }],
} }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService:() => ({ getActiveAccountId:async() => f.account }) }));
vi.mock('@pkg/backend/providerCliUpdates', () => ({ captureProviderCliSnapshot:async() => undefined }));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({ GraphRegistry:{} }));
vi.mock('@pkg/agent/tools/agents/jobRegistry', async(importOriginal) => ({
  ...await importOriginal<object>(), createJob:f.create,
}));
// Owner mappings exist for the parent manager and for one named role; launch overrides must bypass them.
vi.mock('@pkg/agent/services/WorkerModelRouting', async(importOriginal) => {
  const { workerModelRouting } = await importOriginal<typeof import('@pkg/agent/services/WorkerModelRouting')>();
  return {
    installWorkerRoute: vi.fn(),
    workerModelRouting: {
      explicitTierRoute:workerModelRouting.explicitTierRoute.bind(workerModelRouting),
      newRoute: vi.fn(async(slug: string) => {
        f.captured.push(slug);
        if (slug === 'pending') throw new Error('mapping is still being registered');
        return ['mapped-manager', 'luna'].includes(slug) ? { version: 1, slug, agentId: `${ slug }-id`, revision: 1, selected: 0, candidates: [{ provider: 'codex', model: `${ slug }-mapped` }] } : undefined;
      }),
      subscriptionConnections: vi.fn(async() => ({ grok: 'oauth' })),
    },
  };
});

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
    expect(result.result).toContain('Requested model');
    expect(launch).not.toHaveBeenCalled();
  });

  it('enforces a configured tier policy at spawn and captures only the approved exact candidate and account', async() => {
    const candidate = { provider:'codex', model:'listed', effort:'high' };
    const modelTiers = { version:1, tiers:[{ candidates:[candidate] }], allowLaunchOverride:'never' };
    f.bindings.luna = { agentId:'luna-id', revision:1, candidates:[candidate], connections:{ codex:'approved' }, modelTiers };
    const { worker, launch } = harness();
    launch.mockRestore(); // Go through launchHidden to the job storage boundary.
    const run = (model:string) => worker.runValidated({ tasks:[{ agentId:'luna', prompt:'fixture', provider:'codex', model }] });
    try {
      expect((await run('listed')).responseString).toContain("doesn't accept");
      modelTiers.allowLaunchOverride = 'listed';
      expect((await run('outside')).responseString).toContain("doesn't list");
      f.account = 'replacement';
      expect((await run('listed')).responseString).toContain('approved account');
      expect(f.create).not.toHaveBeenCalled();
      f.account = 'approved';
      expect((await run('listed')).successBoolean).toBe(true);
      const [task] = f.create.mock.calls[0][0];
      expect(task.workerModelRoute).toMatchObject({ candidates:[candidate], requestedModel:candidate, connections:{ codex:'approved' } });
      // Recovery and visible tabs must retain the same account-bound pin.
      expect(resolveLaunchModelPrecedence({ override:task, workerModelRoute:task.workerModelRoute }).workerModelRoute).toEqual(task.workerModelRoute);
    } finally { delete f.bindings.luna; f.create.mockClear(); f.account = 'approved' }
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
