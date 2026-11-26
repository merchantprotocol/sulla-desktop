// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentModelStatus } from '@pkg/shared/agentState/AgentModelStatus';
import { ThreadAgentActivityPresenter } from '@pkg/services/agentState/ThreadAgentActivityPresenter';
import type { AgentRowState, AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { AgentJobCheckin } from '@pkg/agent/database/models/AgentJobMessagingModel';
import type { AgentTraceHistoryData } from '@pkg/agent/app/Services/AgentTraceHistory';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';
import { LegacyAgentNotices } from '../../messages/legacyAgentNotice';
import type { Message, ProactiveMessage, SubAgentExchangeMessage, SubAgentMessage } from '../../models/Message';
import { TracePayload } from './TracePayloadSerializer';
import type { TraceRow, SubAgentTraceStatus, SubAgentTraceDetails } from './traceTypes';

export interface SubAgentTraceInput {
  agents?: readonly AgentStateRow[];
}

interface JobTrace {
  key: string;
  first: Message;
  live?: AgentStateRow;
  launch?: SubAgentExchangeMessage;
  exchange?: SubAgentExchangeMessage;
  result?: { item: AgentResultItem; at: number; message: ProactiveMessage };
  legacy?: ProactiveMessage;
  native?: SubAgentMessage;
}

const states: Record<AgentRowState, SubAgentTraceStatus> = {
  // A parked task is still running (waiting on a timer or its children); the
  // approved row has exactly seven status words, so it reads as working.
  queued: 'starting', working: 'working', quiet: 'quiet', parked: 'working', blocked: 'blocked',
  done: 'returned', failed: 'failed', lost: 'failed', stopped: 'stopped',
};
const resultStates: Record<AgentResultItem['status'], SubAgentTraceStatus> = {
  completed: 'returned', error: 'failed', stopped: 'stopped', blocked: 'blocked',
};
const exchangeStates: Record<SubAgentExchangeMessage['status'], SubAgentTraceStatus> = {
  running: 'working', done: 'returned', failed: 'failed', stopped: 'stopped',
};
const legacyStates: Record<string, SubAgentTraceStatus> = { Done: 'returned', Failed: 'failed', Blocked: 'blocked', Stopped: 'stopped' };

const statusLabels: Record<SubAgentTraceStatus, string> = {
  starting: 'starting', working: 'working', quiet: 'no check-in', blocked: 'blocked',
  returned: 'returned', failed: 'failed', stopped: 'stopped',
};

/** Correlates a worker's records while emitting each visible event at its own timestamp. */
export class SubAgentTraceProjection {
  /** The one status word the approved row shows. */
  static statusLabel(status: SubAgentTraceStatus): string { return statusLabels[status]; }

  /** "2 agents: 1 returned, 1 working" for the turn header, in first-seen status order. */
  static summary(statuses: readonly SubAgentTraceStatus[]): string | undefined {
    if (!statuses.length) return undefined;
    const counts = new Map<string, number>();
    for (const status of statuses) {
      const label = statusLabels[status];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts].map(([label, count]) => `${ count } ${ label }`).join(', ');
    return `${ statuses.length } ${ statuses.length === 1 ? 'agent' : 'agents' }: ${ parts }`;
  }

  statusRowsByMessage(messages: readonly Message[], input: SubAgentTraceInput): Map<string, TraceRow[]> {
    const result = new Map<string, TraceRow[]>();
    for (const job of this.jobs(messages, input)) {
      const source = String(job.first.id);
      const rows = result.get(source) ?? [];
      rows.push(this.row(job));
      result.set(source, rows);
    }
    return result;
  }

  /** Individual lifecycle events for the continuous timeline. */
  eventRowsByMessage(messages: readonly Message[], input: SubAgentTraceInput): Map<string, TraceRow[]> {
    const result = new Map<string, TraceRow[]>();
    for (const job of this.jobs(messages, input)) {
      for (const row of this.eventRows(job)) {
        const source = row.sourceMessageId ?? String(job.first.id);
        const rows = result.get(source) ?? [];
        rows.push(row);
        result.set(source, rows);
      }
    }
    return result;
  }

  private jobs(messages: readonly Message[], input: SubAgentTraceInput): JobTrace[] {
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
          const at = Math.max(item.endedAt ?? message.createdAt, message.createdAt);
          if (!job.result || at >= job.result.at) job.result = { item, at, message };
        }
        const legacy = !message.result && LegacyAgentNotices.parseLegacyAgentNotice(message.headline, message.body);
        if (legacy) {
          const job = get(legacy.jobId ? this.taskKey(legacy.jobId) : `message:${ message.id }`);
          if (!job.legacy || message.createdAt >= job.legacy.createdAt) job.legacy = message;
        }
      }
    }

    return [...jobs.values()];
  }

  private eventRows(job: JobTrace): TraceRow[] {
    const aggregate = this.row(job);
    const { launch, exchange, legacy, native, live } = job;
    const rows: TraceRow[] = [];

    if (launch) rows.push({ ...aggregate, id: `subagent:${job.key}:handoff`, kind: 'handoff', icon: 'handoff',
      verb: 'Handed off to', status: live ? states[live.state] : 'starting', note: launch.summary || undefined,
      at: launch.createdAt, anchorEntryId: String(launch.id), sourceMessageId: String(launch.id) });

    if (native) rows.push({ ...aggregate, id: `subagent:${job.key}:native`, kind: 'activity', icon: 'dot',
      verb: 'Agent status', status: ({ running: 'working', done: 'returned', error: 'failed' } as const)[native.status],
      note: native.desc, at: native.createdAt, anchorEntryId: String(native.id), sourceMessageId: String(native.id) });

    const endedLiveAt = this.timestamp(live?.endedAt);
    let settled: { at: number; status: SubAgentTraceStatus; note?: string; sourceMessageId: string; durationLabel?: string } | undefined;
    if (job.result) settled = {
      at: job.result.at,
      status: resultStates[job.result.item.status],
      note: job.result.item.problem || job.result.item.outcome,
      sourceMessageId: String(job.result.message.id),
      ...(job.result.item.durationMs !== undefined ? { durationLabel: this.duration(job.result.item.durationMs) } : {}),
    };
    else if (exchange && exchange.status !== 'running') settled = {
      at: exchange.createdAt, status: exchangeStates[exchange.status], note: exchange.summary,
      sourceMessageId: String(exchange.id),
    };
    else if (legacy) {
      const parsed = LegacyAgentNotices.parseLegacyAgentNotice(legacy.headline, legacy.body);
      if (parsed) settled = { at: legacy.createdAt, status: legacyStates[parsed.verdict], note: legacy.headline, sourceMessageId: String(legacy.id) };
    }
    else if (live && endedLiveAt !== undefined && ['returned', 'failed', 'stopped'].includes(states[live.state])) settled = {
      at: endedLiveAt, status: states[live.state], note: live.stopReason || live.stateReason || undefined,
      sourceMessageId: String(launch?.id ?? job.first.id),
    };

    if (settled) rows.push({ ...aggregate, id: `subagent:${job.key}:result`, kind: 'result', icon: 'result',
      verb: 'Result from', status: settled.status, note: settled.note, at: settled.at,
      anchorEntryId: settled.sourceMessageId, sourceMessageId: settled.sourceMessageId,
      ...(settled.durationLabel ? { durationLabel: settled.durationLabel } : {}) });
    else if (exchange?.status === 'running') rows.push({ ...aggregate, id: `subagent:${job.key}:checkin:${exchange.createdAt}`,
      kind: 'activity', icon: 'dot', verb: 'Check-in', status: live ? states[live.state] : 'working',
      note: exchange.summary || undefined, at: exchange.createdAt, anchorEntryId: String(exchange.id), sourceMessageId: String(exchange.id) });

    if (live && !settled) {
      const at = this.timestamp(live.lastCheckinAt) ?? this.timestamp(live.lastActivityAt) ?? this.timestamp(live.startedAt);
      const note = live.lastCheckinSummary || live.stateReason || live.waitReason || undefined;
      if (at !== undefined && note) {
        const sourceMessageId = String(launch?.id ?? job.first.id);
        rows.push({ ...aggregate, id: `subagent:${job.key}:status:${at}`, kind: 'activity', icon: 'dot',
          verb: 'Status', status: states[live.state], note, at, anchorEntryId: sourceMessageId, sourceMessageId });
      }
    }

    if (!rows.length) rows.push({ ...aggregate, id: `subagent:${job.key}:status`, kind: 'activity', icon: 'dot',
      verb: 'Status', at: job.first.createdAt, anchorEntryId: String(job.first.id), sourceMessageId: String(job.first.id) });
    return rows;
  }

  private taskKey(jobId: string, index = 0): string { return `${ jobId }:${ index }`; }

  private row(job: JobTrace): TraceRow {
    const { first, live, launch, exchange, legacy, native } = job;
    const result = job.result?.item;
    const old = legacy && LegacyAgentNotices.parseLegacyAgentNotice(legacy.headline, legacy.body);
    const label = launch?.label ?? result?.label ?? exchange?.label ?? live?.label ?? native?.name ?? old?.label ?? 'Sub-agent';
    const agentId = launch?.agentId ?? result?.agentId ?? exchange?.agentId ?? live?.agentId ?? native?.name;
    const endedLiveAt = this.timestamp(live?.endedAt);
    const startedLiveAt = this.timestamp(live?.startedAt);
    const reopened = startedLiveAt !== undefined && job.result !== undefined && startedLiveAt > job.result.at;
    // The exchange uses a coarse status (contract blockers are emitted as
    // failed). Prefer the structured settlement over its transport envelope.
    const settled = result && job.result && !reopened
      ? { at: job.result.at, status: resultStates[result.status], note: result.problem || result.outcome }
      : live && endedLiveAt !== undefined
        ? { at: endedLiveAt, status: states[live.state], note: live.stopReason || live.stateReason }
        : exchange && !reopened && exchange.status !== 'running'
          ? { at: exchange.createdAt, status: exchangeStates[exchange.status], note: exchange.summary }
          : old && legacy && !reopened
            ? { at: legacy.createdAt, status: legacyStates[old.verdict], note: legacy.headline }
            : undefined;
    const status = settled?.status ?? (live ? states[live.state] :
      exchange ? exchangeStates[exchange.status] :
      native ? ({ running: 'working', done: 'returned', error: 'failed' } as const)[native.status] :
      launch?.status && launch.status !== 'running' ? exchangeStates[launch.status] : 'starting');
    const ended = status === 'returned' || status === 'failed' || status === 'stopped';
    const liveNote = live && (live.state === 'parked'
      ? live.lastCheckinSummary || live.waitReason || live.stateReason
      : live.stateReason || live.lastCheckinSummary);
    const note = settled?.note ?? (live ? liveNote || launch?.summary :
      native?.desc ?? exchange?.summary ?? launch?.summary ?? legacy?.headline);
    const modelStatus = live?.modelStatus ?? result?.modelStatus;
    const startedAt = (reopened ? startedLiveAt : result?.startedAt ?? startedLiveAt) ?? launch?.createdAt ?? native?.createdAt;
    const endedAt = settled?.at ?? (ended ? native?.createdAt ?? this.timestamp(live?.lastActivityAt) ?? launch?.createdAt : undefined);
    const lastCheckinAt = this.timestamp(live?.lastCheckinAt);
    const report = [exchange?.detail, result?.report].filter((value, index, values) => value && values.indexOf(value) === index).join('\n\n');
    const details: SubAgentTraceDetails = {
      agentId, marker: ThreadAgentActivityPresenter.initials(agentId, job.key), conversationId: launch?.conversationId ?? result?.threadId ?? exchange?.conversationId ?? live?.threadId ?? undefined,
      jobId: launch?.jobId ?? result?.jobId ?? exchange?.jobId ?? live?.jobId ?? old?.jobId,
      taskIndex: launch?.taskIndex ?? result?.taskIndex ?? exchange?.taskIndex ?? live?.taskIndex,
      model: modelStatus ? AgentModelStatus.label(modelStatus) : result?.model,
      runLocation: result?.runLocation, isReviewer: result?.purpose === 'review',
      startedAt, endedAt, noteAt: settled || ended ? undefined : lastCheckinAt,
      durationMs: !reopened && result?.durationMs !== undefined ? result.durationMs
        : endedAt !== undefined && startedAt !== undefined ? endedAt - startedAt : undefined,
      followUpOf: this.followUp(live?.followUpOf ?? result?.followUpOf),
      brief: launch?.detail, briefAt: launch?.createdAt,
      checkinAt: lastCheckinAt, checkinSummary: live?.lastCheckinSummary ?? undefined,
      report: report || legacy?.body || native?.steps.map(step => `${ step.tag }  ${ step.text }`).join('\n') ||
        (ended ? note || 'No report recorded.' : 'Not returned yet.'),
    };
    return { id: `subagent:${ job.key }`, kind: 'subagent', icon: 'dot', verb: '', target: label, targetIsCode: false, status,
      at: first.createdAt, anchorEntryId: String(first.id), sourceMessageId: String(first.id), note,
      payload: new TracePayload([status, details.brief, details.briefAt, details.checkinAt, details.checkinSummary,
        details.endedAt, details.report], (history, messages) => this.disclosure(details, status, history, messages)),
      durationLabel: !reopened && result?.durationMs !== undefined ? this.duration(result.durationMs) : undefined,
      subagent: details,
    };
  }

  disclosure(details: SubAgentTraceDetails, status: SubAgentTraceStatus, history: readonly AgentJobCheckin[] = [],
    messages: AgentTraceHistoryData['messages'] = []): string {
    const checkins = [...history];
    const { checkinAt, checkinSummary, briefAt, brief, endedAt } = details;
    if (checkinAt !== undefined && checkinSummary && !history.some(entry => entry.createdAt === checkinAt && entry.summary === checkinSummary)) {
      checkins.push({ createdAt: checkinAt, summary: checkinSummary, step: '', blockers: [], filesTouched: [] });
    }
    // Check-ins and messages sent to the worker, interleaved by time, word for word.
    // agent_job_messages records no sender, so a message is labelled as a message, not as Sulla's.
    const timeline = [
      ...checkins.map(entry => ({ at: entry.createdAt, text: [
        `${ this.timeLabel(entry.createdAt) }  ${ entry.summary }${ entry.percent !== undefined ? ` · ${ entry.percent }%` : '' }`,
        ...(entry.step ? [entry.step] : []), ...entry.blockers, ...entry.filesTouched,
      ].join('\n') })),
      ...messages.map(entry => ({ at: entry.createdAt, text: `${ this.timeLabel(entry.createdAt) }  ← message: ${ entry.message }` })),
    ].sort((a, b) => a.at - b.at);
    const formattedCheckins = timeline.map(entry => entry.text).join('\n');
    return [
      brief && `BRIEF${ briefAt !== undefined ? ` · sent ${ this.timeLabel(briefAt) }` : '' }
${ brief }`,
      `CHECK-INS
${ formattedCheckins || 'None recorded.' }`,
      `REPORT${ endedAt !== undefined ? ` · ${ this.reportHeader(details, status, endedAt) }` : '' }
${ details.report }`,
    ].filter(Boolean).join('\n\n');
  }

  /** "completed 1:07:52 PM · 3m 40s". Results record no token count, so none is shown. */
  private reportHeader(details: SubAgentTraceDetails, status: SubAgentTraceStatus, endedAt: number): string {
    const word = status === 'returned' ? 'completed' : statusLabels[status];
    return [`${ word } ${ this.timeLabel(endedAt) }`, details.durationMs !== undefined ? this.duration(details.durationMs) : undefined]
      .filter(Boolean).join(' · ');
  }

  private followUp(ref?: { jobId?: unknown; taskIndex?: unknown } | null): SubAgentTraceDetails['followUpOf'] {
    return ref && typeof ref.jobId === 'string' && ref.jobId && Number.isInteger(ref.taskIndex)
      ? { jobId: ref.jobId, taskIndex: ref.taskIndex as number } : undefined;
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
