import { describe, expect, it } from '@jest/globals';

import { ReflexEngine } from '../ReflexEngine';
import { DEFAULT_REFLEX_THRESHOLD, reflexPolicyViolation } from '../reflexPolicy';
import seed from '../seed/route-seed.json';

const heldOut = [
  'show me revenue by week as a chart',
  'mock up three layouts for the settings page',
  'merge the approved pull request',
];

function routeEngineWithoutHeldOut(): ReflexEngine {
  const omitted = new Set(heldOut);
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

  it('routes every starter example to its taught persona above the act threshold', () => {
    const engine = new ReflexEngine(seed.examples.map((example, index) => ({
      id: String(index), utterance: example.utterance, toolName: example.tool, params: example.params, positive: example.positive,
    })));
    const mistakes = seed.examples.flatMap((example) => {
      const prediction = engine.predict(example.utterance);
      return prediction.params.agentId === example.params.agentId && prediction.confidence >= DEFAULT_REFLEX_THRESHOLD
        ? []
        : [`${ example.utterance } -> ${ String(prediction.params.agentId) } (${ prediction.confidence })`];
    });
    expect(mistakes).toEqual([]);
  });

  it.each([
    [heldOut[0], 'analytics-worker'],
    [heldOut[1], 'mockup-designer'],
    [heldOut[2], 'sulla'],
  ])('routes held-out phrasing %s to %s', (utterance, agentId) => {
    const prediction = routeEngineWithoutHeldOut().predict(utterance);
    expect(prediction.toolName).toBe('route_agent');
    expect(prediction.params).toEqual({ agentId });
    expect(prediction.confidence).toBeGreaterThanOrEqual(DEFAULT_REFLEX_THRESHOLD);
  });

  it('contains the required starter coverage and no duplicates', () => {
    const counts = seed.examples.reduce<Record<string, number>>((all, example) => {
      const agentId = String(example.params.agentId);
      all[agentId] = (all[agentId] ?? 0) + 1;
      return all;
    }, {});
    expect(counts['analytics-worker']).toBeGreaterThanOrEqual(20);
    expect(counts['mockup-designer']).toBeGreaterThanOrEqual(12);
    expect(counts.sulla).toBeGreaterThanOrEqual(30);
    expect(new Set(seed.examples.map(example => example.utterance.toLowerCase())).size).toBe(seed.examples.length);
  });
});
