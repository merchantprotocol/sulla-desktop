/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';
import {
  type PresentedThreadAgent,
  type ThreadAgentActivityNode,
  type ThreadAgentActivityProjection,
} from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import type { StatusRollupItem, StatusRollupKind } from '../components/composer/StatusRollupQueue';
import { DetailedTraceProjection } from '../components/transcript/DetailedTraceProjection';
import type { TraceRow } from '../components/transcript/traceTypes';
import type { Message } from '../models/Message';
import type { WorkerChartAgent, WorkerChartRole, WorkerChartState } from '../components/workerChart/workerChartModel';

export interface ThreadAgentRunningActionStatus {
  running: boolean;
  count: number;
  label: string | null;
}

/** Adapts the detailed transcript, scoped live snapshots, and authorized trace history into line events. */
export class ThreadAgentActivityMapper {
  public constructor(private readonly traceProjection: DetailedTraceProjection) {}

  checkins(projection: ThreadAgentActivityProjection, threadId: string): StatusRollupItem[] {
    return projection.agents.flatMap(agent => agent.checkins.flatMap(checkin => {
      const item = this.snapshotCheckin(agent, threadId, checkin.at, checkin.summary);
      return item ? [item] : [];
    }));
  }

  snapshotCheckin(agent: PresentedThreadAgent, threadId: string, at = agent.row.lastCheckinAt, summary = agent.row.lastCheckinSummary): StatusRollupItem | null {
    const observedAt = at ? Date.parse(at) : NaN;
    const text = summary?.trim();
    if (!Number.isFinite(observedAt) || !text) return null;
    return this.statusItem(agent, threadId, this.checkinText('', text), observedAt,
      `agent-checkin:${threadId}:${agent.row.key}:${at}:${text}`, 'agent');
  }

  primaryTrace(messages: readonly Message[], threadId: string, agentName: string, now: number): StatusRollupItem[] {
    const recentMessages = messages.slice(-40);
    const byId = new Map(recentMessages.map(message => [String(message.id), message]));
    const rows = this.traceProjection.project(recentMessages, []).flatMap(turn => turn.rows);
    const items = rows.map(row => this.traceItem(row, byId, threadId, agentName, now));
    for (const message of recentMessages) {
      if (message.kind === 'streaming') {
        items.push({
          key: `reply-start:${threadId}:${String(message.id)}`,
          threadId,
          agentId: `chat:${threadId}`,
          agentName: agentName.trim() || 'Sulla',
          kind: 'reply',
          text: 'Writing a reply',
          observedAt: message.startedAt || message.createdAt,
          urgency: 'normal',
          role: 'root',
        });
      } else if (message.kind === 'subagent_exchange' && message.direction === 'to_agent') {
        items.push({
          key: `agent-brief:${threadId}:${String(message.id)}`,
          threadId,
          agentId: message.jobId ? `${message.jobId}:${message.taskIndex ?? 0}` : message.agentId,
          agentName: message.label || message.agentId,
          kind: 'agent',
          text: `Brief sent${message.summary ? `: ${message.summary}` : ''}`,
          observedAt: message.createdAt,
          urgency: 'normal',
          role: 'worker',
        });
      }
    }
    return items.sort((left, right) => left.observedAt - right.observedAt);
  }

  history(agent: PresentedThreadAgent, history: AgentTraceHistoryData, threadId: string): StatusRollupItem[] {
    const items: StatusRollupItem[] = [
      ...history.checkins.map(checkin => this.statusItem(agent, threadId,
        this.checkinText(checkin.step, checkin.summary), checkin.createdAt,
        `agent-checkin:${threadId}:${agent.row.key}:${new Date(checkin.createdAt).toISOString()}:${checkin.summary}`, 'agent')),
      ...history.messages.map(message => this.statusItem(agent, threadId, `Message sent: ${message.message}`, message.createdAt,
        `agent-message:${threadId}:${agent.row.key}:${message.createdAt}:${message.message}`, 'agent')),
    ];
    return items.filter(item => Number.isFinite(item.observedAt)).sort((left, right) => left.observedAt - right.observedAt);
  }

  state(agent: PresentedThreadAgent, threadId: string, at: number, key: string): StatusRollupItem {
    const { row } = agent;
    const label = this.stateLabel(agent.state);
    const detail = row.stateReason?.trim();
    return this.statusItem(agent, threadId, detail && ['blocked', 'failed', 'lost', 'stopped'].includes(agent.state)
      ? `${label}: ${detail}` : label, at, key, 'agent');
  }

  tool(agent: PresentedThreadAgent, threadId: string, name: string, at: number, key: string, phase: 'started' | 'finished' | 'failed', correlationId: string): StatusRollupItem {
    const kind = this.toolKind(name);
    const item = this.statusItem(agent, threadId, `${phase === 'started' ? 'Running' : phase === 'failed' ? 'Failed' : 'Finished'} ${name}`,
      at, key, kind);
    return {
      ...item,
      phase: phase === 'started' ? 'start' : 'result',
      correlationId,
      ...(phase === 'failed' ? { urgency: 'failed' as const } : {}),
    };
  }

  liveActivity(agent: PresentedThreadAgent, threadId: string, at: number, key: string): StatusRollupItem {
    return this.statusItem(agent, threadId, agent.row.stateReason?.trim() || this.stateLabel(agent.state), at, key, 'status');
  }

  rootFallback(projection: ThreadAgentActivityProjection, threadId: string | undefined, now: number): StatusRollupItem | null {
    if (!threadId || projection.scope === 'empty') return null;
    const ownRows = projection.agents.filter(agent => agent.row.threadId === threadId);
    // A fallback is only safe when the active thread identifies exactly one of its own agent rows.
    if (ownRows.length !== 1) return null;
    const ownRoot = ownRows[0];
    const lastText = ownRoot.row.lastCheckinSummary?.trim() || ownRoot.row.stateReason?.trim() || this.stateLabel(ownRoot.row.state);
    const observedAt = this.timestamp(ownRoot.row.lastCheckinAt ?? ownRoot.row.lastActivityAt, now) ?? now;
    return this.statusItem(ownRoot, threadId, lastText, observedAt, `${ownRoot.row.key}:fallback`, 'status', 'root');
  }

  runningActionStatus(projection: ThreadAgentActivityProjection): ThreadAgentRunningActionStatus {
    let count = 0;
    let label: string | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    let running = false;

    for (const agent of projection.agents) {
      const { row } = agent;
      if (row.state !== 'working') continue;
      running = true;
      if (Number.isFinite(row.actionCount)) count += row.actionCount ?? 0;

      const action = row.lastAction;
      if (!action || !action.label) continue;
      const at = Date.parse(action.at);
      if (label === null || (Number.isFinite(at) && at >= latestAt)) {
        label = action.label;
        if (Number.isFinite(at)) latestAt = at;
      }
    }

    return { running, count, label };
  }

  chartRoot(projection: ThreadAgentActivityProjection, threadId: string | undefined): WorkerChartAgent | null {
    if (!threadId || projection.scope === 'empty' || !projection.roots.length) return null;

    const roots = projection.roots.map(node => this.chartNode(node));
    if (projection.scope === 'child' && roots.length === 1) return { ...roots[0], role: 'main' };

    // A root chat can launch several independent top-level jobs. Keep every
    // scoped tree visible under the chat's virtual root instead of dropping siblings.
    return {
      id: `chat:${threadId}`,
      name: 'Sulla',
      initials: 'S',
      role: 'main',
      state: this.aggregateState(roots),
      children: roots,
    };
  }

  private traceItem(row: TraceRow, byId: ReadonlyMap<string, Message>, threadId: string, agentName: string, now: number): StatusRollupItem {
    const message = byId.get(String(row.id));
    const agentRow = row.kind === 'subagent' ? row.subagent : undefined;
    const name = row.kind === 'subagent' ? row.target : agentName.trim() || 'Sulla';
    const kind = this.traceKind(row, message);
    const text = this.traceText(row, message);
    const at = Number.isFinite(row.at) ? row.at! : now;
    const state = row.status;
    const urgency = state === 'failed' ? 'failed' : state === 'blocked' || state === 'waiting' ? 'needs-you' : 'normal';
    return {
      key: row.kind === 'thought'
        ? `trace:${threadId}:${row.id}:${state}:${row.verb}`
        : `trace:${threadId}:${row.id}:${state}:${row.verb}:${row.target}`,
      threadId,
      agentId: agentRow?.jobId ? `${agentRow.jobId}:${agentRow.taskIndex ?? 0}` : `chat:${threadId}`,
      agentName: name,
      kind,
      text,
      observedAt: at,
      urgency,
      role: agentRow ? 'worker' : 'root',
      ...(row.kind === 'tool' ? { phase: state === 'running' ? 'start' as const : 'result' as const, correlationId: `primary:${threadId}:${row.id}` } : {}),
    };
  }

  private traceKind(row: TraceRow, message?: Message): StatusRollupKind {
    if (row.kind === 'thought') return 'thought';
    if (row.kind === 'activity' || row.kind === 'approval' || row.kind === 'heartbeat') return 'status';
    if (row.kind === 'source') return 'read';
    if (row.kind === 'tool' && message?.kind === 'tool') return this.toolKind(message.recordedToolName ?? message.tool);
    if (row.kind === 'subagent') return 'agent';
    return row.kind === 'memory' ? 'edit' : 'status';
  }

  private traceText(row: TraceRow, message?: Message): string {
    switch (row.kind) {
      case 'tool': {
        if (message?.kind !== 'tool') return `${row.verb} ${row.target}`;
        return message.desc?.trim() || message.recordedToolName || message.tool;
      }
      case 'thought': return row.target;
      case 'activity': return row.target;
      case 'source': return `${row.verb}: ${row.target}`;
      case 'approval': {
        const reason = message?.kind === 'tool_approval' ? message.reason : row.target;
        return `${row.status === 'waiting' ? 'Needs you' : 'Approval'}: ${reason}`;
      }
      case 'subagent': return `${row.status}${row.note ? `: ${row.note}` : ''}`;
      case 'heartbeat': return `${row.verb}: ${row.target}`;
      case 'memory': return `${row.verb}: ${row.target}`;
      default: return `${row.verb}: ${row.target}`;
    }
  }

  private statusItem(
    agent: PresentedThreadAgent,
    threadId: string,
    text: string,
    observedAt: number,
    key: string,
    kind: StatusRollupKind,
    role?: StatusRollupItem['role'],
  ): StatusRollupItem {
    return {
      key,
      threadId,
      agentId: agent.row.key,
      agentName: agent.row.label?.trim() || agent.row.agentId || 'Agent',
      lane: agent.lane,
      kind,
      text,
      observedAt,
      urgency: agent.urgency,
      role: role ?? (agent.row.waitingOnChildren > 0 ? 'manager' : 'worker'),
    };
  }

  private checkinText(step: string, summary: string): string {
    return step && step !== summary ? `${step}: ${summary}` : summary;
  }

  private toolKind(name: string): StatusRollupKind {
    if (/^(?:Read|Glob|Grep|LS|Search|Fetch|Browser)/i.test(name)) return 'read';
    if (/^(?:Edit|Write|Patch|Replace)/i.test(name)) return 'edit';
    if (/^(?:Bash|exec|run|shell)/i.test(name)) return 'run';
    return 'tool';
  }

  private chartNode(node: ThreadAgentActivityNode): WorkerChartAgent {
    const { agent } = node;
    const row = agent.row;
    const latestCheckin = agent.checkins[agent.checkins.length - 1];
    return {
      id: row.key,
      name: row.label?.trim() || row.agentId || 'Agent',
      initials: agent.initials,
      role: this.chartRole(agent, node.children.length > 0),
      lane: agent.lane,
      state: this.chartState(agent),
      model: row.modelStatus?.model ?? null,
      task: row.label?.trim() || undefined,
      startedAt: this.timestamp(row.startedAt),
      finishedAt: this.timestamp(row.endedAt),
      lastCheckIn: latestCheckin ? { timestamp: this.timestamp(latestCheckin.at)!, text: latestCheckin.summary } : null,
      activity: agent.activity.flatMap(sample => {
        return Number.isFinite(sample.at) && sample.count > 0 ? [{ timestamp: sample.at, value: sample.count }] : [];
      }),
      children: node.children.map(child => this.chartNode(child)),
    };
  }

  private chartRole(agent: PresentedThreadAgent, hasChildren: boolean): WorkerChartRole {
    const row = agent.row;
    if (/^review/i.test(row.label.trim())) return 'rev';
    if (hasChildren || row.canLaunchAgents) return 'mgr';
    return 'wrk';
  }

  private chartState(agent: PresentedThreadAgent): WorkerChartState {
    if (agent.urgency === 'failed' || agent.state === 'lost') return 'failed';
    if (agent.urgency === 'needs-you') return 'needs-you';
    if (agent.state === 'quiet') return 'idle';
    if (agent.state === 'queued' || agent.state === 'parked') return 'parked';
    if (agent.state === 'done' || agent.state === 'stopped') return 'done';
    return 'working';
  }

  private aggregateState(roots: readonly WorkerChartAgent[]): WorkerChartState {
    const states = roots.map(root => root.state);
    if (states.includes('failed')) return 'failed';
    if (states.includes('needs-you')) return 'needs-you';
    if (states.includes('working')) return 'working';
    if (states.includes('parked')) return 'parked';
    if (states.includes('idle')) return 'idle';
    return 'done';
  }

  private stateLabel(state: PresentedThreadAgent['state']): string {
    switch (state) {
      case 'queued': return 'Starting';
      case 'working': return 'Working';
      case 'parked': return 'Working';
      case 'quiet': return 'Quiet';
      case 'blocked': return 'Needs you';
      case 'failed': return 'Failed';
      case 'lost': return 'Not reporting';
      case 'stopped': return 'Stopped';
      case 'done': return 'Returned';
    }
  }

  timestamp(value: string | null | undefined, fallback?: number): number | null {
    if (!value) return fallback ?? null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback ?? null;
  }
}
