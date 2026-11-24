// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow, AgentStateSnapshot, AgentRowState } from '@pkg/shared/agentState/AgentStateSnapshot';
import { AgentTreeBuilder, type AgentTreeNode } from './AgentTreeBuilder';

export type ThreadAgentUrgency = 'normal' | 'needs-you' | 'failed';
export type ThreadAgentScope = 'root' | 'child' | 'host' | 'empty';

export interface ObservedAgentCheckin { at: string; summary: string }
export interface PresentedThreadAgent {
  row: AgentStateRow;
  agentId: string | null;
  initials: string;
  lane: string;
  state: AgentRowState;
  urgency: ThreadAgentUrgency;
  checkins: readonly ObservedAgentCheckin[];
  activity: readonly string[];
}
export interface ThreadAgentActivityNode { agent: PresentedThreadAgent; depth: number; children: ThreadAgentActivityNode[] }
export interface ThreadAgentActivityProjection {
  threadId?: string;
  scope: ThreadAgentScope;
  decisionIds: readonly string[];
  roots: ThreadAgentActivityNode[];
  agents: readonly PresentedThreadAgent[];
}

/** Projects the shared live-agent snapshot into only the current thread's proven tree. */
export class ThreadAgentActivityPresenter {
  static readonly activityWindowMs = 150_000;
  static readonly orphanTtlMs = 150_000;
  static readonly maxCheckinsPerAgent = 6;
  static readonly maxActivityPerAgent = 30;

  private acceptedVersion = -1;
  private activeThreadId?: string;
  private initialized = false;
  private checkins = new Map<string, ObservedAgentCheckin[]>();
  private activity = new Map<string, string[]>();
  private current: ThreadAgentActivityProjection = { scope: 'empty', decisionIds: [], roots: [], agents: [] };

  project(snapshot: AgentStateSnapshot, threadId: string | undefined, now = Date.now()): ThreadAgentActivityProjection {
    const threadChanged = !this.initialized || this.activeThreadId !== threadId;
    if (threadChanged) {
      this.initialized = true;
      this.activeThreadId = threadId;
      this.checkins.clear();
      this.activity.clear();
      this.current = { threadId, scope: 'empty', decisionIds: [], roots: [], agents: [] };
    }
    if (!snapshot || snapshot.version < this.acceptedVersion || (!threadChanged && snapshot.version <= this.acceptedVersion)) return this.current;
    this.acceptedVersion = Math.max(this.acceptedVersion, snapshot.version);

    const builder = new AgentTreeBuilder(snapshot.rows);
    const scoped = this.scopeTree(builder, snapshot.rows, threadId, now);
    const flat = builder.flatten(scoped.roots);
    for (const node of flat) this.observe(node.row, now);
    this.prune(now, new Set(flat.map(node => node.row.key)));

    const agents = flat.map(node => this.present(node.row));
    const byKey = new Map(agents.map(agent => [agent.row.key, agent]));
    const roots = scoped.roots.map(node => this.presentTree(node, byKey));
    this.current = {
      threadId,
      scope: scoped.scope,
      decisionIds: [...new Set(flat.flatMap(node => node.row.decisionIds ?? []))],
      roots,
      agents,
    };
    return this.current;
  }

  private scopeTree(builder: AgentTreeBuilder, rows: readonly AgentStateRow[], threadId: string | undefined, now: number): { scope: ThreadAgentScope; roots: AgentTreeNode[] } {
    if (threadId === undefined) {
      const liveHostRows = rows.filter(row => row.rootThreadId === null && this.isRecent(row.lastActivityAt, now, ThreadAgentActivityPresenter.orphanTtlMs));
      return { scope: liveHostRows.length ? 'host' : 'empty', roots: new AgentTreeBuilder(liveHostRows).forThread(null) };
    }

    const rootRows = rows.filter(row => row.rootThreadId === threadId);
    if (rootRows.length) return { scope: 'root', roots: builder.forThread(threadId) };

    const matches = rows.filter(row => row.threadId === threadId && row.rootThreadId !== null);
    const rootIds = [...new Set(matches.map(row => row.rootThreadId!))];
    // An exact child-thread match proves descendants only when it identifies one root.
    if (rootIds.length !== 1 || matches.length === 0) return { scope: 'empty', roots: [] };
    const allRoots = builder.forThread(rootIds[0]);
    const matchKeys = new Set(matches.map(row => row.key));
    return { scope: 'child', roots: this.matchedSubtrees(allRoots, matchKeys) };
  }

  private matchedSubtrees(nodes: readonly AgentTreeNode[], matches: ReadonlySet<string>): AgentTreeNode[] {
    const result: AgentTreeNode[] = [];
    const collect = (node: AgentTreeNode): void => {
      if (matches.has(node.row.key)) { result.push(node); return }
      node.children.forEach(collect);
    };
    nodes.forEach(collect);
    return result;
  }

  private observe(row: AgentStateRow, now: number): void {
    const at = row.lastCheckinAt;
    if (at && row.lastCheckinSummary?.trim() && this.isRecent(at, now, ThreadAgentActivityPresenter.activityWindowMs)) {
      const history = this.checkins.get(row.key) ?? [];
      if (!history.some(item => item.at === at && item.summary === row.lastCheckinSummary)) {
        history.push({ at, summary: row.lastCheckinSummary.trim() });
        this.checkins.set(row.key, history.slice(-ThreadAgentActivityPresenter.maxCheckinsPerAgent));
      }
    }
    const activityAt = row.lastActivityAt;
    if (activityAt && this.isRecent(activityAt, now, ThreadAgentActivityPresenter.activityWindowMs)) {
      const history = this.activity.get(row.key) ?? [];
      if (!history.includes(activityAt)) {
        history.push(activityAt);
        this.activity.set(row.key, history.slice(-ThreadAgentActivityPresenter.maxActivityPerAgent));
      }
    }
  }

  private prune(now: number, scopedKeys: ReadonlySet<string>): void {
    for (const [key, entries] of this.checkins) {
      const retained = scopedKeys.has(key) ? entries.filter(item => this.isRecent(item.at, now, ThreadAgentActivityPresenter.activityWindowMs)).slice(-ThreadAgentActivityPresenter.maxCheckinsPerAgent) : [];
      if (retained.length) this.checkins.set(key, retained); else this.checkins.delete(key);
    }
    for (const [key, entries] of this.activity) {
      const retained = scopedKeys.has(key) ? entries.filter(at => this.isRecent(at, now, ThreadAgentActivityPresenter.activityWindowMs)).slice(-ThreadAgentActivityPresenter.maxActivityPerAgent) : [];
      if (retained.length) this.activity.set(key, retained); else this.activity.delete(key);
    }
  }

  private present(row: AgentStateRow): PresentedThreadAgent {
    const stableName = row.agentId?.trim() || row.label.trim() || row.key;
    const initials = stableName.split(/[\s._/-]+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || 'S';
    const urgency: ThreadAgentUrgency = row.state === 'failed' ? 'failed' : row.state === 'blocked' ? 'needs-you' : 'normal';
    return {
      row,
      agentId: row.agentId,
      initials,
      lane: row.agentId ?? 'agent',
      state: row.state,
      urgency,
      checkins: [...(this.checkins.get(row.key) ?? [])],
      activity: [...(this.activity.get(row.key) ?? [])],
    };
  }

  private presentTree(node: AgentTreeNode, byKey: ReadonlyMap<string, PresentedThreadAgent>): ThreadAgentActivityNode {
    return { agent: byKey.get(node.row.key)!, depth: node.depth, children: node.children.map(child => this.presentTree(child, byKey)) };
  }

  private isRecent(value: string, now: number, windowMs: number): boolean {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= windowMs;
  }
}
