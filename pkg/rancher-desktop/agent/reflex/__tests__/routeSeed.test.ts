import { describe, expect, it } from '@jest/globals';

import { ReflexEngine } from '../ReflexEngine';
import { DEFAULT_REFLEX_THRESHOLD, reflexPolicyViolation } from '../reflexPolicy';
import seed from '../seed/route-seed.json';

// Near-paraphrases of seed rows: these must still route with the row removed.
const heldOut: [string, string][] = [
  ['show me revenue by week as a chart', 'analytics-worker'],
  ['add validation to the signup form', 'director'],
  ['how long will this project take', 'project-manager'],
  ['merge the approved pull request', 'account-manager'],
];

function routeEngine(omit: string[] = []): ReflexEngine {
  const omitted = new Set(omit);
  return new ReflexEngine(seed.examples
    .filter(example => !omitted.has(example.utterance))
    .map((example, index) => ({
      id:        String(index),
      utterance: example.utterance,
      toolName:  example.tool,
      params:    example.params,
      positive:  example.positive,
    })));
}

describe('Reflex route seed', () => {
  it('allows route_agent training even when chat is not an action category', () => {
    expect(reflexPolicyViolation({
      toolName: 'route_agent', category: 'chat', params: { agentId: 'analytics-worker' }, allowedCategories: [],
    })).toBeNull();
  });

  it('classifies every starter example as its taught agent and never fires a wrong one', () => {
    const engine = routeEngine();
    const mistakes = seed.examples.flatMap((example) => {
      const prediction = engine.predict(example.utterance);
      return prediction.params.agentId === example.params.agentId
        ? []
        : [`${ example.utterance } -> ${ String(prediction.params.agentId) } (${ prediction.confidence })`];
    });
    expect(mistakes).toEqual([]);
  });

  // Routing is precision-first: a confident wrong route makes the chat sticky
  // on the wrong agent, while a miss just opens on the default front door
  // (account-manager), which delegates. Leave-one-out must never fire wrong.
  it('never routes an unseen seed phrasing to the wrong agent above the act threshold', () => {
    const wrong = seed.examples.flatMap((example) => {
      const prediction = routeEngine([example.utterance]).predict(example.utterance);
      return prediction.toolName === 'route_agent' && prediction.confidence >= DEFAULT_REFLEX_THRESHOLD &&
        prediction.params.agentId !== example.params.agentId
        ? [`${ example.utterance } -> ${ String(prediction.params.agentId) } (${ prediction.confidence })`]
        : [];
    });
    expect(wrong).toEqual([]);
  });

  it.each(heldOut)('routes held-out phrasing %s to %s', (utterance, agentId) => {
    const prediction = routeEngine([utterance]).predict(utterance);
    expect(prediction.toolName).toBe('route_agent');
    expect(prediction.params).toEqual({ agentId });
    expect(prediction.confidence).toBeGreaterThanOrEqual(DEFAULT_REFLEX_THRESHOLD);
  });

  it('covers every front-door agent, never routes to a retired agent, and has no duplicates', () => {
    const counts = seed.examples.reduce<Record<string, number>>((all, example) => {
      const agentId = String(example.params.agentId);
      all[agentId] = (all[agentId] ?? 0) + 1;
      return all;
    }, {});
    expect(counts['account-manager']).toBeGreaterThanOrEqual(50);
    for (const agentId of ['analytics-worker', 'mockup-designer', 'director', 'ui-test-manager', 'project-manager', 'integrator', 'premortem-planner']) {
      expect(counts[agentId]).toBeGreaterThanOrEqual(12);
    }
    // Retired targets (see RETIRED_ROUTE_AGENTS in ReflexSeedSeeder).
    for (const agentId of ['sulla', 'project-planner', 'coding-manager']) expect(counts[agentId]).toBeUndefined();
    expect(new Set(seed.examples.map(example => example.utterance.toLowerCase())).size).toBe(seed.examples.length);
  });
});
