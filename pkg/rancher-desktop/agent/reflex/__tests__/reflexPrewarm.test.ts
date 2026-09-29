import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ReflexPrediction } from '../ReflexEngine';

const createTool = jest.fn(async() => ({}));
const runCommand = jest.fn(async() => ({ stdout: '27.0.1', stderr: '', exitCode: 0 }));
const listProjects = jest.fn(async() => []);

jest.mock('../../tools/registry', () => ({ toolRegistry: { createTool: (name: string) => (createTool as any)(name) } }));
jest.mock('../../tools/util/CommandRunner', () => ({ runCommand: (...args: any[]) => (runCommand as any)(...args) }));
jest.mock('../../projects/application/ProjectsApplicationService', () => ({
  getProjectsApplicationService: () => ({ ready: async() => undefined, listProjects: (opts: any) => (listProjects as any)(opts) }),
}));

// eslint-disable-next-line import/first
import { formatPrewarmTiming, planReflexPrewarm, resetReflexPrewarmCache, startReflexPrewarm } from '../reflexPrewarm';

const CATEGORIES: Record<string, string> = {
  docker_logs: 'docker', docker_ps: 'docker', list_project_items: 'project', open_tab: 'ui', screenshot: 'browser',
};
const categoryOf = (t: string) => CATEGORIES[t];

const prediction = (candidates: [string, number][]): ReflexPrediction => ({
  toolName:   candidates[0]?.[0] ?? 'none',
  params:     {},
  confidence: candidates[0]?.[1] ?? 0,
  similarity: 0,
  support:    1,
  neighbours: [],
  candidates: candidates.map(([toolName, confidence]) => ({ toolName, params: {}, confidence, support: 1 })),
  reason:     'test',
});

describe('planReflexPrewarm', () => {
  it('warms below-threshold guesses down to the floor, capped, by category', () => {
    const plan = planReflexPrewarm(prediction([['docker_logs', 0.41], ['docker_ps', 0.3], ['open_tab', 0.25], ['screenshot', 0.22], ['list_project_items', 0.1]]), categoryOf);
    expect(plan.tools).toEqual(['docker_logs', 'docker_ps', 'open_tab']);
    expect(plan.categories).toEqual(['docker', 'ui']);
  });

  it('plans nothing when Reflex says no action', () => {
    expect(planReflexPrewarm(prediction([]), categoryOf)).toEqual({ tools: [], categories: [] });
  });
});

describe('startReflexPrewarm', () => {
  beforeEach(() => {
    resetReflexPrewarmCache();
    createTool.mockClear();
    runCommand.mockClear();
    listProjects.mockClear();
  });

  it('loads the tool module and runs the read-only category warm-up', async() => {
    const h = startReflexPrewarm(prediction([['docker_logs', 0.35]]), categoryOf);
    await h.done;
    expect(createTool).toHaveBeenCalledWith('docker_logs');
    expect(runCommand).toHaveBeenCalledWith('docker', ['version', '--format', '{{.Server.Version}}'], expect.anything());
    expect(h.status).toBe('done');
    expect(h.warmed.sort()).toEqual(['category:docker', 'tool:docker_logs']);
  });

  it('is cheap on repeat: keystrokes and turns share one warm-up', async() => {
    await Promise.all([
      startReflexPrewarm(prediction([['list_project_items', 0.5]]), categoryOf).done,
      startReflexPrewarm(prediction([['list_project_items', 0.5]]), categoryOf).done,
    ]);
    const again = startReflexPrewarm(prediction([['list_project_items', 0.5]]), categoryOf);
    await again.done;
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(createTool).toHaveBeenCalledTimes(1);
    expect(again.warmed).toEqual([]);
  });

  it('does nothing when disabled, but still reports the predicted category for baseline timing', async() => {
    const h = startReflexPrewarm(prediction([['docker_ps', 0.9]]), categoryOf, { enabled: false });
    await h.done;
    expect(createTool).not.toHaveBeenCalled();
    expect(formatPrewarmTiming(h)).toBe('predicted=docker prewarm=off');
  });

  it('skips warm-ups once the turn is over', async() => {
    const ctrl = new AbortController();
    ctrl.abort();
    const h = startReflexPrewarm(prediction([['docker_ps', 0.9]]), categoryOf, { signal: ctrl.signal });
    await h.done;
    expect(createTool).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(h.status).toBe('aborted');
  });

  it('swallows a failing warm-up', async() => {
    runCommand.mockRejectedValueOnce(new Error('daemon down'));
    const h = startReflexPrewarm(prediction([['docker_ps', 0.9]]), categoryOf);
    await expect(h.done).resolves.toBeUndefined();
    expect(h.status).toBe('done');
  });

  it('formats a no-prediction turn', () => {
    expect(formatPrewarmTiming(null)).toBe('predicted=none prewarm=off');
  });
});
