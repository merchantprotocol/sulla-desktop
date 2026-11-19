// SPDX-License-Identifier: GPL-2.0-or-later
import '../../../Support/TestHomeEnv';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toolDecisionPort } from '@pkg/agent/tools/toolDecisionPort';
import { agentToolManifests } from '@pkg/agent/tools/agents/manifests';
import { SpawnAgentWorker, taskGraphAgentChannel } from '@pkg/agent/tools/agents/spawn_agent';

const f = vi.hoisted(() => ({ captured: [] as string[] }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/services/AgentDefinitionService', () => ({ agentDefinitionService: { findBySlug: async(slug: string) => slug === 'luna' ? { id: 'luna-id', slug } : null } }));
vi.mock('@pkg/agent/services/AgentLaunchPauseService', () => ({ agentLaunchPauseService: { isPaused: () => Promise.resolve(false) } }));
// Owner mappings exist for the parent manager and for one named role; the default agent has none.
vi.mock('@pkg/agent/services/WorkerModelRouting', () => ({
  installWorkerRoute: vi.fn(),
  workerModelRouting: {
    newRoute: vi.fn(async(slug: string) => {
      f.captured.push(slug);
      return ['mapped-manager', 'luna'].includes(slug) ? { version: 1, slug, agentId: `${ slug }-id`, revision: 1, selected: 0, candidates: [{ provider: 'codex', model: `${ slug }-mapped` }] } : undefined;
    }),
  },
}));

function harness() {
  vi.spyOn(toolDecisionPort.resolve(), 'requiresApproval').mockResolvedValue(false);
  const worker = new SpawnAgentWorker(); worker.name = 'spawn_agent';
  worker.setState({ metadata: { subAgentDepth: 0, wsChannel: 'mapped-manager' } } as any);
  worker.schemaDef = agentToolManifests.find(m => m.name === 'spawn_agent')!.schemaDef!;
  const launch = vi.spyOn(worker as any, 'launchHidden').mockResolvedValue({ successBoolean: true, responseString: 'accepted', result: {} });
  const routeFor = (task: unknown) => (worker as any).workerRoutes.get(task);
  return { worker, launch, routeFor };
}
afterEach(() => { vi.restoreAllMocks(); f.captured = [] });

describe('spawn_agent worker mapping identity', () => {
  it('captures the default agent mapping, not the parent manager mapping, for a selector-less explicit-model task', async() => {
    const { worker, launch, routeFor } = harness();
    const result = await worker.call({ tasks: [{ prompt: 'synthetic work', model: 'gpt-6-luna' }] });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(f.captured).toEqual(['sulla-desktop']);
    const [task] = launch.mock.calls[0][0] as any[];
    // The child runs the sulla-desktop graph with the caller's explicit model, unaffected by the manager's mapping.
    expect(routeFor(task)).toBeUndefined();
    expect(task.model).toBe('gpt-6-luna');
    expect(taskGraphAgentChannel(task, 'mapped-manager')).toBe('sulla-desktop');
  });

  it('keeps the named role owner mapping when that role is selected', async() => {
    const { worker, launch, routeFor } = harness();
    await worker.call({ tasks: [{ prompt: 'synthetic work', agentId: 'luna', model: 'gpt-6-luna' }] });
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
