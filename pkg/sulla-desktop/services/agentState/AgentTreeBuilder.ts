// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

export interface AgentTreeNode { row: AgentStateRow; children: AgentTreeNode[]; depth: number }

export class AgentTreeBuilder {
  private readonly liveStates = new Set<AgentStateRow['state']>(['queued', 'working', 'parked', 'quiet', 'blocked']);
  constructor(private readonly rows: readonly AgentStateRow[]) {}

  forThread(rootThreadId: string): AgentTreeNode[] {
    const included = this.rows.filter(row => row.rootThreadId === rootThreadId);
    const nodes = new Map(included.map(row => [row.key, { row, children: [] as AgentTreeNode[], depth: 0 }]));
    const roots: AgentTreeNode[] = [];

    for (const node of nodes.values()) {
      const { parentJobId, parentTaskIndex } = node.row;
      const parentKey = parentJobId === null || parentTaskIndex === null ? null : `${ parentJobId }:${ parentTaskIndex }`;
      const parent = parentKey ? nodes.get(parentKey) : undefined;

      if (parent && !this.createsCycle(node, parent, nodes)) parent.children.push(node);
      else roots.push(node); // Orphans and malformed cycles remain visible as roots.
    }
    this.assignDepths(roots, 0);
    this.sort(roots);
    return roots;
  }

  groups(): { rootThreadId: string; tree: AgentTreeNode[] }[] {
    const ids = [...new Set(this.rows.map(row => row.rootThreadId).filter((id): id is string => !!id))];
    return ids.map(rootThreadId => ({ rootThreadId, tree: this.forThread(rootThreadId) }))
      .filter(group => group.tree.length > 0)
      .sort((a, b) => this.compare(a.tree[0].row, b.tree[0].row));
  }

  flatten(tree: readonly AgentTreeNode[]): AgentTreeNode[] {
    const flattened: AgentTreeNode[] = [];
    const visited = new Set<string>();
    const visit = (nodes: readonly AgentTreeNode[]): void => {
      for (const node of nodes) {
        if (visited.has(node.row.key)) continue;
        visited.add(node.row.key);
        flattened.push(node);
        visit(node.children);
      }
    };
    visit(tree);
    return flattened;
  }

  private createsCycle(node: AgentTreeNode, parent: AgentTreeNode, nodes: ReadonlyMap<string, AgentTreeNode>): boolean {
    const visited = new Set<string>([node.row.key]);
    let candidate: AgentTreeNode | undefined = parent;
    while (candidate) {
      if (visited.has(candidate.row.key)) return true;
      visited.add(candidate.row.key);
      const parentJobId: string | null = candidate.row.parentJobId;
      const parentTaskIndex: number | null = candidate.row.parentTaskIndex;
      candidate = parentJobId === null || parentTaskIndex === null ? undefined : nodes.get(`${ parentJobId }:${ parentTaskIndex }`);
    }
    return false;
  }

  private assignDepths(nodes: readonly AgentTreeNode[], depth: number): void {
    for (const node of nodes) { node.depth = depth; this.assignDepths(node.children, depth + 1) }
  }

  private sort(nodes: AgentTreeNode[]): void {
    nodes.sort((a, b) => this.compare(a.row, b.row));
    nodes.forEach(node => this.sort(node.children));
  }

  private compare(a: AgentStateRow, b: AgentStateRow): number {
    const live = Number(this.liveStates.has(b.state)) - Number(this.liveStates.has(a.state));
    if (live) return live;
    return this.time(a.startedAt) - this.time(b.startedAt) || a.key.localeCompare(b.key);
  }

  private time(value: string | null): number { return value ? Date.parse(value) || 0 : 0 }
}
