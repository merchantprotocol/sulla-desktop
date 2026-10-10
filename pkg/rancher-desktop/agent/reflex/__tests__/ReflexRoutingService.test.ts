import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ReflexExample } from '../ReflexEngine';

const examples: ReflexExample[] = [
  { id: 'action', utterance: 'open projects', toolName: 'open_tab', params: { mode: 'projects' }, positive: true },
  { id: 'route', utterance: 'chart weekly revenue', toolName: 'route_agent', params: { agentId: 'analytics-worker' }, positive: true },
];
const decisions: any[] = [];
const settings: Record<string, string> = {};
const resolveRoutableAgentMock = jest.fn((agentId: string) => Promise.resolve({
  agentId, graphAgentId: agentId, name: 'Analytics Worker',
}));

jest.unstable_mockModule('../../database/models/ReflexModel', () => ({
  ReflexModel: {
    version:        1,
    activeExamples: jest.fn(() => Promise.resolve(examples)),
    recordDecision: jest.fn((decision: any) => {
      decisions.push(decision);
      return Promise.resolve(`decision-${ decisions.length }`);
    }),
  },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: jest.fn((key: string, fallback: string) => Promise.resolve(settings[key] ?? fallback)) },
}));
jest.unstable_mockModule('../../tools/registry', () => ({
  toolRegistry: {
    getCategories:           () => ['ui', 'chat'],
    getToolNamesForCategory: (category: string) => category === 'chat' ? ['route_agent'] : ['open_tab'],
  },
}));
jest.unstable_mockModule('../../services/ChatAgentRouting', () => ({
  resolveRoutableAgent: resolveRoutableAgentMock,
}));

let getReflexEngine: typeof import('../ReflexService').getReflexEngine;
let getRouteReflexEngine: typeof import('../ReflexService').getRouteReflexEngine;
let routeChatAgent: typeof import('../ReflexService').routeChatAgent;

describe('Reflex route/action engine isolation', () => {
  beforeAll(async() => {
    ({ getReflexEngine, getRouteReflexEngine, routeChatAgent } = await import('../ReflexService'));
  });

  beforeEach(() => {
    decisions.length = 0;
    for (const key of Object.keys(settings)) delete settings[key];
    resolveRoutableAgentMock.mockClear();
  });

  it('keeps route examples out of normal action prediction', async() => {
    const actionEngine = await getReflexEngine();
    expect(actionEngine.size).toBe(1);
    expect(actionEngine.predict('chart weekly revenue').toolName).toBe('none');
  });

  it('keeps only route examples in the first-message route engine', async() => {
    const routeEngine = await getRouteReflexEngine();
    expect(routeEngine.size).toBe(1);
    expect(routeEngine.predict('chart weekly revenue')).toEqual(expect.objectContaining({
      toolName: 'route_agent',
      params:   { agentId: 'analytics-worker' },
    }));
  });

  it('returns a usable above-threshold route and records the switch', async() => {
    await expect(routeChatAgent('chart weekly revenue', 'thread-1')).resolves.toEqual({
      agentId: 'analytics-worker', confidence: 1, decisionId: 'decision-1',
    });
    expect(resolveRoutableAgentMock).toHaveBeenCalledWith('analytics-worker');
    expect(decisions).toEqual([expect.objectContaining({
      thread_id: 'thread-1', tool_name: 'route_agent', status: 'acted', params: { agentId: 'analytics-worker' },
    })]);
  });

  it('honors reflexRouteEnabled=false without recording a decision', async() => {
    settings.reflexRouteEnabled = 'false';
    await expect(routeChatAgent('chart weekly revenue', 'thread-1')).resolves.toBeNull();
    expect(decisions).toEqual([]);
  });
});
