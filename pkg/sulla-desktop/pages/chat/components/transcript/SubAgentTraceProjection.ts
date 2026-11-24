// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type TraceRowKind = 'thought' | 'tool' | 'memory' | 'heartbeat' | 'activity' | 'handoff' | 'retry' | 'approval' | 'usage' | 'source' | 'subagent';
import { AgentModelStatus } from '@pkg/shared/agentState/AgentModelStatus';
import type { AgentRowState, AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';
import { LegacyAgentNotices } from '../../messages/legacyAgentNotice';
import type { Message, ProactiveMessage, SubAgentExchangeMessage, SubAgentMessage } from '../../models/Message';
import type { TraceRow, SubAgentTraceStatus } from './traceTypes';

export interface SubAgentTraceCheckin {
  at: number;
  summary: string;
  percent?: number;
  blockers?: readonly string[];
  filesTouched?: readonly string[];
}

export interface SubAgentTraceInput {
  agents?: readonly AgentStateRow[];
  checkins?: ReadonlyMap<string, readonly SubAgentTraceCheckin[]>;
}

interface JobTrace {
  key: string;
  first: Message;
  live?: AgentStateRow;
  launch?: SubAgentExchangeMessage;
  exchange?: SubAgentExchangeMessage;
  result?: { item: AgentResultItem; at: number };
  legacy?: ProactiveMessage;
  native?: SubAgentMessage;
}

const states: Record<AgentRowState, SubAgentTraceStatus> = {
  queued: 'starting', working: 'working', quiet: 'quiet', parked: 'waiting', blocked: 'blocked',
  done: 'returned', failed: 'failed', lost: 'failed', stopped: 'stopped',
};
const resultStates: Record<AgentResultItem['status'], SubAgentTraceStatus> = {
  completed: 'returned', error: 'failed', stopped: 'stopped', blocked: 'blocked',
};
const exchangeStates: Record<SubAgentExchangeMessage['status'], SubAgentTraceStatus> = {
  running: 'working', done: 'returned', failed: 'failed', stopped: 'stopped',
};
const legacyStates: Record<string, SubAgentTraceStatus> = { Done: 'returned', Failed: 'failed', Blocked: 'blocked', Stopped: 'stopped' };

/** Collects related events across the whole chat; the row stays in the first event's turn. */
export class SubAgentTraceProjection {
  rowsByMessage(messages: readonly Message[], input: SubAgentTraceInput): Map<string, TraceRow[]> {
    const agents = new Map(input.agents?.map(row => [row.key, row]));
    const byThread = new Map<string, string>();
    for (const message of messages) {
      if (message.kind === 'subagent_exchange' && message.jobId && message.conversationId) {
        byThread.set(message.conversationId, this.taskKey(message.jobId, message.taskIndex));
      } else if (message.kind === 'proactive') {
        for (const item of message.result?.items ?? []) if (item.threadId) byThread.set(item.threadId, this.taskKey(item.jobId, item.taskIndex));
      }
    }
    for (const row of agents.values()) if (row.threadId && !byThread.has(row.threadId)) byThread.set(row.threadId, row.key);
    const jobs = new Map<string, JobTrace>();
    const seen = new Set<string>();
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const get = (key: string): JobTrace => {
        let job = jobs.get(key);
        if (!job) {
          job = { key, first: message, live: agents.get(key) };
          jobs.set(key, job);
        }
        return job;
      };
      if (message.kind === 'subagent_exchange') {
        const key = message.jobId ? this.taskKey(message.jobId, message.taskIndex) :
          (message.conversationId && (byThread.get(message.conversationId) ?? `thread:${ message.conversationId }`)) || `message:${ message.id }`;
        const job = get(key);
        if (message.direction === 'to_agent') {
          if (!job.launch || message.createdAt < job.launch.createdAt) job.launch = message;
        }
        else if (!job.exchange || message.createdAt >= job.exchange.createdAt) job.exchange = message;
      } else if (message.kind === 'subagent') {
        get(`native:${ message.id }`).native = message;
      } else if (message.kind === 'proactive') {
        for (const item of message.result?.items ?? []) {
          const job = get(this.taskKey(item.jobId, item.taskIndex));
          const at = item.endedAt ?? message.createdAt;
          if (!job.result || at >= job.result.at) job.result = { item, at };
        }
        const legacy = !message.result && LegacyAgentNotices.parseLegacyAgentNotice(message.headline, message.body);
        if (legacy) {
          const job = get(legacy.jobId ? this.taskKey(legacy.jobId) : `message:${ message.id }`);
          if (!job.legacy || message.createdAt >= job.legacy.createdAt) job.legacy = message;
        }
      }
    }

    const result = new Map<string, TraceRow[]>();
    for (const job of jobs.values()) {
      const rows = result.get(job.first.id) ?? [];
      rows.push(this.row(job, input.checkins?.get(job.key) ?? []));
      result.set(job.first.id, rows);
    }
    return result;
  }

  private taskKey(jobId: string, index = 0): string { return `${ jobId }:${ index }`; }

  private row(job: JobTrace, history: readonly SubAgentTraceCheckin[]): TraceRow {
    const { first, live, launch, exchange, legacy, native } = job;
    const result = job.result?.item;
    const old = legacy && LegacyAgentNotices.parseLegacyAgentNotice(legacy.headline, legacy.body);
    const label = launch?.label ?? result?.label ?? exchange?.label ?? live?.label ?? native?.name ?? old?.label ?? 'Sub-agent';
    const agentId = launch?.agentId ?? result?.agentId ?? exchange?.agentId ?? live?.agentId ?? native?.name;
    const latest = history.at(-1);
    const endedLiveAt = this.timestamp(live?.endedAt);
    const transitions: { at: number; status: SubAgentTraceStatus; note?: string }[] = [];
    if (old && legacy) transitions.push({ at: legacy.createdAt, status: legacyStates[old.verdict], note: legacy.headline });
    if (exchange && exchange.status !== 'running') transitions.push({ at: exchange.createdAt, status: exchangeStates[exchange.status], note: exchange.summary });
    if (live && endedLiveAt !== undefined) transitions.push({ at: endedLiveAt, status: states[live.state], note: live.stateReason ?? undefined });
    if (result && job.result) transitions.push({ at: job.result.at, status: resultStates[result.status], note: result.problem || result.outcome });
    // A terminal event trumps a stale running snapshot; newer terminal events
    // win over earlier ones, with structured result data preferred on ties.
    const settled = transitions.reduce<typeof transitions[number] | undefined>((latest, candidate) => !latest || candidate.at >= latest.at ? candidate : latest, undefined);
    const status = settled?.status ?? (live ? states[live.state] :
      exchange ? exchangeStates[exchange.status] :
      native ? ({ running: 'working', done: 'returned', error: 'failed' } as const)[native.status] :
      launch?.status && launch.status !== 'running' ? exchangeStates[launch.status] : 'starting');
    const ended = status === 'returned' || status === 'failed' || status === 'stopped';
    const note = settled?.note ?? (live ? live.stateReason || live.lastCheckinSummary || latest?.summary || launch?.summary :
      native?.desc ?? exchange?.summary ?? latest?.summary ?? launch?.summary ?? legacy?.headline);
    const modelStatus = live?.modelStatus ?? result?.modelStatus;
    const startedAt = result?.startedAt ?? this.timestamp(live?.startedAt) ?? launch?.createdAt ?? native?.createdAt;
    const endedAt = settled?.at ?? (ended ? native?.createdAt ?? this.timestamp(live?.lastActivityAt) ?? launch?.createdAt : undefined);
    const brief = launch?.detail;
    const checkins = [...history];
    const lastCheckinAt = this.timestamp(live?.lastCheckinAt);
    if (lastCheckinAt !== undefined && live?.lastCheckinSummary && !checkins.some(entry => entry.at === lastCheckinAt && entry.summary === live.lastCheckinSummary)) {
      checkins.push({ at: lastCheckinAt, summary: live.lastCheckinSummary });
      checkins.sort((a, b) => a.at - b.at);
    }
    const formattedCheckins = checkins.map(entry => [
      `${ this.timeLabel(entry.at) }  ${ entry.summary }${ entry.percent !== undefined ? ` · ${ entry.percent }%` : '' }`,
      ...(entry.blockers ?? []), ...(entry.filesTouched ?? []),
    ].join('\n')).join('\n');
    const report = [exchange?.detail, result?.report].filter((value, index, values) => value && values.indexOf(value) === index).join('\n\n');
    const rawPayload = [
      launch && brief && `BRIEF · sent ${ this.timeLabel(launch.createdAt) }\n${ brief }`,
      `CHECK-INS\n${ formattedCheckins || 'None recorded.' }`,
      `REPORT${ endedAt !== undefined ? ` · ${ status } ${ this.timeLabel(endedAt) }` : '' }\n${ report || legacy?.body || native?.steps.map(step => `${ step.tag }  ${ step.text }`).join('\n') || (ended ? note : 'Not returned yet.') || 'No report recorded.' }`,
    ].filter(Boolean).join('\n\n');

    return { id: `subagent:${ job.key }`, kind: 'subagent', verb: '', target: label, targetIsCode: false, status,
      at: first.createdAt, anchorEntryId: '', note, rawPayload,
      durationLabel: result?.durationMs !== undefined ? this.duration(result.durationMs) : undefined,
      subagent: {
        agentId, conversationId: launch?.conversationId ?? result?.threadId ?? exchange?.conversationId ?? live?.threadId ?? undefined,
        jobId: launch?.jobId ?? result?.jobId ?? exchange?.jobId ?? live?.jobId ?? old?.jobId,
        taskIndex: launch?.taskIndex ?? result?.taskIndex ?? exchange?.taskIndex ?? live?.taskIndex,
        model: modelStatus ? AgentModelStatus.label(modelStatus) : result?.model,
        runLocation: result?.runLocation, isReviewer: result?.purpose === 'review', hasBrief: !!brief,
        startedAt, endedAt, noteAt: settled || ended ? undefined : lastCheckinAt ?? latest?.at,
      },
    };
  }

  duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1_000));
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${ minutes }m ${ String(seconds % 60).padStart(2, '0') }s` : `${ seconds }s`;
  }

  private timestamp(value?: string | null): number | undefined {
    const at = Date.parse(value ?? '');
    return Number.isFinite(at) ? at : undefined;
  }

  private timeLabel(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
}
