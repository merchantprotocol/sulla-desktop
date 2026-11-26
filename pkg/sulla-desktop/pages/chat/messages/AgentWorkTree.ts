// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

export interface AgentWorkLink {
  key: string;
  kind: 'assignment' | 'follow-up';
}

export interface AgentWorkNode {
  row: AgentStateRow;
  links: AgentWorkLink[];
}

export interface AgentWorkGroup {
  key: string;
  title: string;
  linked: boolean;
  nodes: AgentWorkNode[];
}

export interface AgentWorkTreeOptions {
  /** Keep a selected settled branch visible after its last worker returns. */
  includeSettled?: boolean;
}

/** Joins recorded references in this chat. Titles, PR numbers and model names never create links. */
export class AgentWorkTree {
  static live(row: AgentStateRow): boolean {
    return ['queued', 'working', 'parked', 'quiet', 'blocked'].includes(row.state);
  }

  static links(row: AgentStateRow): AgentWorkLink[] {
    const links: AgentWorkLink[] = [];
    const add = (kind: AgentWorkLink['kind'], jobId?: string | null, index?: number | null) => {
      if (typeof jobId !== 'string' || !jobId.trim() || index == null || !Number.isInteger(index) || index < 0) return;
      const key = `${ jobId }:${ index }`;
      if (key !== row.key) links.push({ key, kind });
    };
    add('assignment', row.parentJobId, row.parentTaskIndex);
    add('follow-up', row.followUpOf?.jobId, row.followUpOf?.taskIndex);
    return links;
  }

  /**
   * Selects the work that belongs in the Sulla overview. Live branches win. Once
   * they settle, only the newest connected branch remains; Activity owns the
   * complete chronological history.
   */
  static current(
    rows: readonly AgentStateRow[], threadId?: string,
    activeKeys?: ReadonlySet<string>, recentKeys?: ReadonlySet<string>,
  ): AgentStateRow[] {
    if (!threadId) return [];
    const scoped = rows.filter(row => row.rootThreadId === threadId);
    if (!scoped.length) return [];
    const byKey = new Map(scoped.map(row => [row.key, row]));
    const live = activeKeys
      ? scoped.filter(row => activeKeys.has(row.key))
      : scoped.filter(row => this.live(row));
    const timestamp = (row: AgentStateRow) => Date.parse(row.endedAt ?? row.lastActivityAt ?? row.startedAt ?? '') || 0;
    const parents = new Set(scoped.flatMap(row => this.links(row).map(link => link.key)).filter(key => byKey.has(key)));
    const leaves = scoped.filter(row => !parents.has(row.key));
    const newest = [...(leaves.length ? leaves : scoped)].sort((a, b) => timestamp(b) - timestamp(a) || b.key.localeCompare(a.key))[0];
    const seeds = live.length ? live : [newest];
    const selected = new Set(seeds.map(row => row.key));
    const pending = [...selected];
    while (pending.length) {
      const key = pending.shift()!;
      for (const next of this.links(byKey.get(key)!)) {
        if (!byKey.has(next.key)) continue;
        if (selected.has(next.key)) continue;
        selected.add(next.key);
        pending.push(next.key);
      }
    }
    if (live.length) {
      const recent = recentKeys ?? new Set(scoped.map(row => row.key));
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of scoped) {
          if (selected.has(row.key) || !recent.has(row.key) || !this.links(row).some(link => selected.has(link.key))) continue;
          selected.add(row.key);
          changed = true;
        }
      }
    }
    return scoped.filter(row => selected.has(row.key));
  }

  static build(rows: readonly AgentStateRow[], threadId?: string, options: AgentWorkTreeOptions = {}): AgentWorkGroup[] {
    if (!threadId) return [];
    const scoped = rows.filter(row => row.rootThreadId === threadId);
    const otherKeys = new Set(rows.filter(row => row.rootThreadId !== threadId).map(row => row.key));
    const byKey = new Map(scoped.map(row => [row.key, row]));
    const parents = new Map<string, string>();
    const component = (key: string): string => {
      let root = key;
      while (parents.has(root)) root = parents.get(root)!;
      let cursor = key;
      while (parents.has(cursor) && parents.get(cursor) !== root) {
        const next = parents.get(cursor)!;
        parents.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    const join = (a: string, b: string) => {
      const left = component(a);
      const right = component(b);
      if (left !== right) parents.set(left < right ? right : left, left < right ? left : right);
    };
    const links = new Map<string, AgentWorkLink[]>();
    for (const row of scoped) {
      const refs = this.links(row).filter(ref => !otherKeys.has(ref.key));
      links.set(row.key, refs);
      for (const ref of refs) join(row.key, ref.key);
      if (row.taskId) join(row.key, `task:${ row.taskId }`);
    }
    const buckets = new Map<string, AgentStateRow[]>();
    for (const row of byKey.values()) {
      const key = component(row.key);
      const members = buckets.get(key) ?? [];
      members.push(row);
      buckets.set(key, members);
    }
    const groups: AgentWorkGroup[] = [];
    const unlinked: AgentWorkNode[] = [];
    for (const [key, members] of buckets) {
      if (!options.includeSettled && !members.some(row => this.live(row))) continue;
      members.sort((a, b) => (Date.parse(a.startedAt ?? '') || 0) - (Date.parse(b.startedAt ?? '') || 0) || a.key.localeCompare(b.key));
      const nodes = members.map(row => ({ row, links: links.get(row.key) ?? [] }));
      if (nodes.length === 1 && !nodes[0].row.taskId && !nodes[0].links.length) {
        unlinked.push(nodes[0]);
        continue;
      }
      const root = nodes.find(node => !node.links.some(link => byKey.has(link.key)));
      const title = nodes.length === 1 && nodes[0].links.length ? 'Work from an earlier job' : (root ?? nodes[0]).row.label;
      groups.push({ key, title, linked: true, nodes });
    }
    if (unlinked.length) groups.push({ key: 'unlinked', title: 'Unlinked work', linked: false, nodes: unlinked });
    return groups;
  }

  /** Draw one incoming line per card. Both recorded references remain available in the inspector. */
  static layout(nodes: AgentWorkNode[]) {
    const keys = new Set(nodes.map(node => node.row.key));
    const incoming = new Map<string, AgentWorkLink>();
    for (const node of nodes) {
      const visible = node.links.filter(link => keys.has(link.key));
      const link = visible.find(entry => entry.kind === 'follow-up') ?? visible[0];
      if (link) incoming.set(node.row.key, link);
    }

    const branches = new Set([...incoming.values()].map(link => link.key));
    const rows: AgentWorkNode[][] = [nodes.filter(node => !incoming.has(node.row.key))];
    const placed = new Set(rows[0].map(node => node.row.key));
    while (placed.size < nodes.length) {
      const previous = new Set(rows.at(-1)?.map(node => node.row.key));
      const next = nodes.filter(node => previous.has(incoming.get(node.row.key)?.key ?? '') && !placed.has(node.row.key));
      if (!next.length) break;
      // Keep the ongoing branch in the first column alongside any independent jobs.
      next.sort((a, b) => Number(branches.has(b.row.key)) - Number(branches.has(a.row.key)));
      rows.push(next);
      for (const node of next) placed.add(node.row.key);
    }
    if (!incoming.size || placed.size < nodes.length) return { rows: [nodes], incoming, style: 'list' };
    if (rows.length === 2 && rows[0].length === 1 && rows[1].length > 2) return { rows, incoming, style: 'fan' };
    const small = rows.length <= 4 && rows.every(level => level.length <= 2);
    return { rows: small ? rows : [nodes], incoming, style: small ? 'map' : 'list' };
  }
}
