// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

export interface AgentTreeNode { row: AgentStateRow; children: AgentTreeNode[] }

const LIVE_STATES = new Set<AgentStateRow['state']>(['queued', 'working', 'parked', 'quiet', 'blocked']);

export class AgentTreeBuilder {
  constructor(private readonly rows: readonly AgentStateRow[]) {}

  forThread(rootThreadId: string): AgentTreeNode[] {
    const included = this.rows.filter(row => row.rootThreadId === rootThreadId);
    const nodes = new Map(included.map(row => [row.key, { row, children: [] as AgentTreeNode[] }]));
    const roots: AgentTreeNode[] = [];

    for (const node of nodes.values()) {
      const { parentJobId, parentTaskIndex } = node.row;
      const parentKey = parentJobId === null || parentTaskIndex === null ? null : `${parentJobId}:${parentTaskIndex}`;
      const parent = parentKey ? nodes.get(parentKey) : undefined;

      if (parent) parent.children.push(node);
      else roots.push(node); // Orphans stay visible when their parent has already aged out.
    }
    this.sort(roots);
    return roots;
  }

  groups(): Array<{ rootThreadId: string; tree: AgentTreeNode[] }> {
    const ids = [...new Set(this.rows.map(row => row.rootThreadId).filter((id): id is string => !!id))];
    return ids.map(rootThreadId => ({ rootThreadId, tree: this.forThread(rootThreadId) }))
      .filter(group => group.tree.length > 0)
      .sort((a, b) => this.compare(a.tree[0].row, b.tree[0].row));
  }

  flatten(tree: readonly AgentTreeNode[]): AgentTreeNode[] {
    return tree.flatMap(node => [node, ...this.flatten(node.children)]);
  }

  private sort(nodes: AgentTreeNode[]): void {
    nodes.sort((a, b) => this.compare(a.row, b.row));
    nodes.forEach(node => this.sort(node.children));
  }

  private compare(a: AgentStateRow, b: AgentStateRow): number {
    const live = Number(LIVE_STATES.has(b.state)) - Number(LIVE_STATES.has(a.state));
    if (live) return live;
    return this.time(a.startedAt) - this.time(b.startedAt) || a.key.localeCompare(b.key);
  }

  private time(value: string | null): number { return value ? Date.parse(value) || 0 : 0 }
}
