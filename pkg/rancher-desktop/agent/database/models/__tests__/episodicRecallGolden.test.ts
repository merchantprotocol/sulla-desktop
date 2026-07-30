import { describe, expect, it } from '@jest/globals';

import { goldenCases, goldenEdges, goldenNodes, type GoldenEdge } from '../testFixtures/episodicRecallGolden';

interface RankedNode {
  id:         string;
  activation: number;
  hop:        number;
  linkCount:  number;
}

function normAlias(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9#]+/g, '');
}

function adjacency(): Map<string, Array<{ id: string; strength: number }>> {
  const graph = new Map<string, Array<{ id: string; strength: number }>>();
  for (const node of goldenNodes) graph.set(node.id, []);
  for (const edge of goldenEdges) {
    graph.get(edge.src)?.push({ id: edge.dst, strength: edge.strength });
    graph.get(edge.dst)?.push({ id: edge.src, strength: edge.strength });
  }
  return graph;
}

function resolveTerms(terms: string[]): string[] {
  const aliasToNode = new Map<string, string>();
  for (const node of goldenNodes) {
    for (const alias of [node.title, ...node.aliases]) {
      aliasToNode.set(normAlias(alias), node.id);
    }
  }

  return Array.from(new Set(
    terms.map(normAlias).map(term => aliasToNode.get(term)).filter((id): id is string => Boolean(id)),
  ));
}

function spread(terms: string[], maxHops = 2, decay = 0.5, limit = 12): RankedNode[] {
  const graph = adjacency();
  const anchors = resolveTerms(terms);
  const best = new Map<string, RankedNode>();
  const queue: Array<{ id: string; activation: number; hop: number; path: Set<string> }> = anchors.map(id => ({
    id,
    activation: 1,
    hop:        0,
    path:       new Set([id]),
  }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    const existing = best.get(current.id);
    if (!existing || current.activation > existing.activation || current.hop < existing.hop) {
      best.set(current.id, {
        id:         current.id,
        activation: current.activation,
        hop:        existing ? Math.min(existing.hop, current.hop) : current.hop,
        linkCount:  graph.get(current.id)?.length ?? 0,
      });
    }

    if (current.hop >= maxHops) continue;
    for (const next of graph.get(current.id) ?? []) {
      if (current.path.has(next.id)) continue;
      queue.push({
        id:         next.id,
        activation: current.activation * next.strength * decay,
        hop:        current.hop + 1,
        path:       new Set([...current.path, next.id]),
      });
    }
  }

  return Array.from(best.values())
    .sort((a, b) => b.activation - a.activation || b.linkCount - a.linkCount || a.id.localeCompare(b.id))
    .slice(0, limit);
}

describe('Gate B episodic recall golden query eval', () => {
  it('uses a committed fixture graph of the intended size', () => {
    const uniqueEdges = new Set(goldenEdges.map((edge: GoldenEdge) =>
      [edge.src, edge.dst].sort().join('::'),
    ));

    expect(goldenNodes).toHaveLength(40);
    expect(uniqueEdges.size).toBeGreaterThanOrEqual(90);
    expect(uniqueEdges.size).toBeLessThanOrEqual(115);
    expect(goldenCases).toHaveLength(20);
  });

  it('returns expected anchors in top-5 and neighborhoods in top-12 for >=90% of cases', () => {
    let passed = 0;
    const failures: string[] = [];

    for (const testCase of goldenCases) {
      const ranked = spread(testCase.terms);
      const top5 = ranked.slice(0, 5).map(row => row.id);
      const top12 = ranked.map(row => row.id);
      const anchorHit = top5.includes(testCase.expectedAnchorId);
      const neighborhoodHit = testCase.expectedNeighborhood.every(id => top12.includes(id));

      if (anchorHit && neighborhoodHit) {
        passed++;
      } else {
        failures.push(`${ testCase.name }: top5=[${ top5.join(',') }] top12=[${ top12.join(',') }]`);
      }
    }

    const passRate = passed / goldenCases.length;

    expect(failures).toEqual([]);
    expect(passRate).toBeGreaterThanOrEqual(0.9);
  });
});
