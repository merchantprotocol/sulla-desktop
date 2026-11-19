// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

export interface AgentWorkNode { row: AgentStateRow; indent: number; parentLabel?: string; relationship?: string; context: boolean }
export interface AgentWorkGroup { key: string; title: string; linked: boolean; nodes: AgentWorkNode[]; liveCount: number }

/** Presentation only: joins recorded references, never titles, PR numbers or model names. */
export class AgentWorkTree {
  static live(row: AgentStateRow): boolean { return ['queued', 'working', 'parked', 'quiet', 'blocked'].includes(row.state) }

  static build(rows: readonly AgentStateRow[], threadId?: string): AgentWorkGroup[] {
    if (!threadId) return [];
    const scoped = rows.filter(row => row.rootThreadId === threadId);
    const allKeys = new Set(rows.map(row => row.key));
    const byKey = new Map(scoped.map(row => [row.key, row]));
    const parents = new Map<string, string>();
    const component = (key: string): string => {
      let root = key;
      while (parents.has(root) && parents.get(root) !== root) root = parents.get(root)!;
      let cursor = key;
      while (parents.has(cursor) && parents.get(cursor) !== root) { const next = parents.get(cursor)!; parents.set(cursor, root); cursor = next }
      return root;
    };
    const join = (a: string, b: string) => {
      const left = component(a); const right = component(b);
      if (left !== right) parents.set(left < right ? right : left, left < right ? left : right);
    };
    const links = new Map<string, { key: string; relationship: string }[]>();
    for (const row of scoped) {
      const refs: { key: string; relationship: string }[] = [];
      if (typeof row.parentJobId === 'string' && row.parentJobId.trim() && Number.isInteger(row.parentTaskIndex) && row.parentTaskIndex! >= 0) refs.push({ key: `${ row.parentJobId }:${ row.parentTaskIndex }`, relationship: 'Started by' });
      if (row.followUpOf && typeof row.followUpOf.jobId === 'string' && row.followUpOf.jobId.trim() && Number.isInteger(row.followUpOf.taskIndex) && row.followUpOf.taskIndex >= 0) refs.push({ key: `${ row.followUpOf.jobId }:${ row.followUpOf.taskIndex }`, relationship: 'Follow-up to' });
      const safe = refs.filter(ref => ref.key !== row.key && (!allKeys.has(ref.key) || byKey.has(ref.key)));
      links.set(row.key, safe);
      for (const ref of safe) join(row.key, ref.key);
      if (row.taskId) join(row.key, `task:${ row.taskId }`);
    }
    const buckets = new Map<string, AgentStateRow[]>();
    for (const row of scoped) {
      const key = component(row.key);
      const list = buckets.get(key) ?? []; list.push(row); buckets.set(key, list);
    }
    const groups: AgentWorkGroup[] = [];
    const unlinked: AgentWorkNode[] = [];
    for (const [key, members] of buckets) {
      if (!members.some(row => this.live(row))) continue;
      members.sort((a, b) => (Date.parse(a.startedAt ?? '') || 0) - (Date.parse(b.startedAt ?? '') || 0) || a.key.localeCompare(b.key));
      const linked = members.length > 1 || members.some(row => !!row.taskId || links.get(row.key)!.length > 0);
      if (!linked) { unlinked.push({ row: members[0], indent: 0, context: false }); continue }
      const memberKeys = new Set(members.map(row => row.key));
      const primary = new Map(members.map(row => [row.key, links.get(row.key)!.find(ref => memberKeys.has(ref.key))]));
      const children = new Map<string, AgentStateRow[]>();
      for (const row of members) {
        const parent = primary.get(row.key)?.key;
        if (parent) { const list = children.get(parent) ?? []; list.push(row); children.set(parent, list) }
      }
      const visited = new Set<string>(); const nodes: AgentWorkNode[] = [];
      const walk = (row: AgentStateRow, indent: number, parent?: AgentStateRow) => {
        if (visited.has(row.key)) return;
        visited.add(row.key);
        const ref = primary.get(row.key);
        const relationships = links.get(row.key)!.map(link => `${ link.relationship } ${ byKey.get(link.key)?.label ?? 'an earlier task' }`);
        nodes.push({
          row,
          indent,
          parentLabel:  parent && ref?.relationship === 'Started by' ? parent.agentId ?? undefined : undefined,
          context:      !this.live(row),
          relationship: relationships.length ? relationships.join(' · ') : row.taskId ? 'Assigned to a recorded task' : undefined,
        });
        for (const child of children.get(row.key) ?? []) walk(child, indent + 1, row);
      };
      for (const row of members) if (!primary.get(row.key)) walk(row, 0);
      for (const row of members) walk(row, 0); // Cycles remain visible once.
      const title = nodes[0]?.context ? nodes[0].row.label : members.length === 1 && links.get(members[0].key)!.length ? 'Work from an earlier task' : nodes[0].row.label;
      groups.push({ key, title, linked: true, nodes, liveCount: members.filter(row => this.live(row)).length });
    }
    if (unlinked.length) groups.push({ key: 'unlinked', title: 'Unlinked work', linked: false, nodes: unlinked, liveCount: unlinked.length });
    return groups;
  }
}
