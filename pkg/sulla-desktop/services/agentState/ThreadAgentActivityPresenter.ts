// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow, AgentStateSnapshot, AgentRowState } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { DecisionRecord } from '@pkg/shared/decisions';
import { AgentTreeBuilder, type AgentTreeNode } from './AgentTreeBuilder';

export type ThreadAgentUrgency = 'normal' | 'needs-you' | 'failed';
export type ThreadAgentScope = 'root' | 'child' | 'empty';

export interface ObservedAgentCheckin { at: string; summary: string }
export interface ObservedAgentActivity { at: number; count: number }
export interface PresentedThreadAgent {
  row: AgentStateRow;
  agentId: string | null;
  initials: string;
  lane: string;
  state: AgentRowState;
  urgency: ThreadAgentUrgency;
  checkins: readonly ObservedAgentCheckin[];
  activity: readonly ObservedAgentActivity[];
}
export interface ThreadAgentActivityNode { agent: PresentedThreadAgent; depth: number; children: ThreadAgentActivityNode[] }
export interface ThreadAgentActivityProjection {
  threadId?: string;
  scope: ThreadAgentScope;
  decisionIds: readonly string[];
  pendingDecisionIds: readonly string[];
  roots: ThreadAgentActivityNode[];
  agents: readonly PresentedThreadAgent[];
}

/** Projects the shared live-agent snapshot into only the current thread's proven tree. */
export class ThreadAgentActivityPresenter {
  static readonly activityWindowMs = 154_000;
  static readonly maxCheckinsPerAgent = 6;

  /** The marker the worker chart draws for an agent; the Detailed trace reuses it so both point at the same agent. */
  static initials(agentId: string | null | undefined, fallback: string): string {
    const stableName = agentId?.trim() || fallback;
    return stableName.split(/[\s._/-]+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || 'S';
  }

  private acceptedVersion = -1;
  private lastSnapshot?: AgentStateSnapshot;
  private activeThreadId?: string;
  private initialized = false;
  private checkins = new Map<string, ObservedAgentCheckin[]>();
  private activity = new Map<string, ObservedAgentActivity[]>();
  private actionCounts = new Map<string, number>();
  private current: ThreadAgentActivityProjection = { scope: 'empty', decisionIds: [], pendingDecisionIds: [], roots: [], agents: [] };

  project(snapshot: AgentStateSnapshot, threadId: string | undefined, now = Date.now(), decisions: readonly DecisionRecord[] = []): ThreadAgentActivityProjection {
    const threadChanged = !this.initialized || this.activeThreadId !== threadId;
    if (threadChanged) {
      this.initialized = true;
      this.activeThreadId = threadId;
      this.checkins.clear();
      this.activity.clear();
      this.actionCounts.clear();
      this.current = { threadId, scope: 'empty', decisionIds: [], pendingDecisionIds: [], roots: [], agents: [] };
    }
    if (!snapshot || snapshot.version < this.acceptedVersion ||
      (snapshot.version === this.acceptedVersion && !!this.lastSnapshot && snapshot !== this.lastSnapshot)) return this.current;
    this.acceptedVersion = Math.max(this.acceptedVersion, snapshot.version);
    this.lastSnapshot = snapshot;

    const builder = new AgentTreeBuilder(snapshot.rows);
    const scoped = this.scopeTree(builder, snapshot.rows, threadId);
    const flat = builder.flatten(scoped.roots);
    for (const node of flat) this.observe(node.row, now);
    this.prune(now, new Set(flat.map(node => node.row.key)));

    const decisionIds = [...new Set(flat.flatMap(node => node.row.decisionIds ?? []))];
    const scopedThreads = new Set(flat.map(node => node.row.threadId).filter((id): id is string => !!id));
    const pendingDecisions = decisions.filter(decision => ['pending', 'deferred'].includes(decision.status) && decision.expiresAt > now &&
      (scopedThreads.has(decision.conversationId) || (decisionIds.includes(decision.id) && decision.conversationId === scoped.ownerThreadId)));
    const pendingDecisionIds = pendingDecisions.map(decision => decision.id);
    const pendingByThread = new Set(pendingDecisions.map(decision => decision.conversationId));
    const pendingByOwner = new Set(pendingDecisions.filter(decision => decision.conversationId === scoped.ownerThreadId).map(decision => decision.id));
    const needsYouRows = new Set(flat.filter(node => pendingByThread.has(node.row.threadId ?? '') ||
      (node.row.decisionIds ?? []).some(id => pendingByOwner.has(id))).map(node => node.row.key));
    const agents = flat.map(node => this.present(node.row, needsYouRows.has(node.row.key)));
    const byKey = new Map(agents.map(agent => [agent.row.key, agent]));
    const roots = scoped.roots.map(node => this.presentTree(node, byKey));
    this.current = {
      threadId,
      scope: scoped.scope,
      decisionIds,
      pendingDecisionIds,
      roots,
      agents,
    };
    return this.current;
  }

  private scopeTree(builder: AgentTreeBuilder, rows: readonly AgentStateRow[], threadId: string | undefined): { scope: ThreadAgentScope; ownerThreadId?: string; roots: AgentTreeNode[] } {
    if (threadId === undefined) return { scope: 'empty', roots: [] };

    const rootRows = rows.filter(row => row.rootThreadId === threadId);
    if (rootRows.length) return { scope: 'root', ownerThreadId: threadId, roots: builder.forThread(threadId) };

    const matches = rows.filter(row => row.threadId === threadId && row.rootThreadId !== null);
    const rootIds = [...new Set(matches.map(row => row.rootThreadId!))];
    // An exact child-thread match proves descendants only when it identifies one root.
    if (rootIds.length !== 1 || matches.length === 0) return { scope: 'empty', roots: [] };
    const allRoots = builder.forThread(rootIds[0]);
    const matchKeys = new Set(matches.map(row => row.key));
    return { scope: 'child', ownerThreadId: rootIds[0], roots: this.matchedSubtrees(allRoots, matchKeys) };
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
    if (at && row.lastCheckinSummary?.trim() && this.isValidNonFuture(at, now)) {
      const history = this.checkins.get(row.key) ?? [];
      if (!history.some(item => item.at === at && item.summary === row.lastCheckinSummary)) {
        history.push({ at, summary: row.lastCheckinSummary.trim() });
        this.checkins.set(row.key, history.slice(-ThreadAgentActivityPresenter.maxCheckinsPerAgent));
      }
    }
    const count = Number.isFinite(row.actionCount) ? row.actionCount ?? 0 : 0;
    const previous = this.actionCounts.get(row.key);
    this.actionCounts.set(row.key, count);
    const delta = previous !== undefined && count >= previous ? count - previous : 0;
    if (delta > 0) {
      const history = this.activity.get(row.key) ?? [];
      history.push({ at: now, count: delta });
      this.activity.set(row.key, history);
    }
  }

  private prune(now: number, scopedKeys: ReadonlySet<string>): void {
    for (const [key, entries] of this.checkins) {
      const retained = scopedKeys.has(key) ? entries.slice(-ThreadAgentActivityPresenter.maxCheckinsPerAgent) : [];
      if (retained.length) this.checkins.set(key, retained); else this.checkins.delete(key);
    }
    for (const [key, entries] of this.activity) {
      const retained = scopedKeys.has(key) ? entries.filter(sample => now >= sample.at && now - sample.at <= ThreadAgentActivityPresenter.activityWindowMs) : [];
      if (retained.length) this.activity.set(key, retained); else this.activity.delete(key);
    }
    for (const key of this.actionCounts.keys()) if (!scopedKeys.has(key)) this.actionCounts.delete(key);
  }

  private present(row: AgentStateRow, hasPendingDecision: boolean): PresentedThreadAgent {
    const initials = ThreadAgentActivityPresenter.initials(row.agentId, row.key);
    const urgency: ThreadAgentUrgency = row.state === 'failed' ? 'failed' : row.state === 'blocked' || hasPendingDecision ? 'needs-you' : 'normal';
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

  private isValidNonFuture(value: string, now: number): boolean {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now;
  }
}
