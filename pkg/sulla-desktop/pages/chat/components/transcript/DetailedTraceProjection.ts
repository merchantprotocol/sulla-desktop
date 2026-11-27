// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Message, ToolMessage, ThinkingMessage, MemoryMessage, HeartbeatMessage, ToolApprovalMessage, CitationMessage, SullaMessage } from '../../models/Message';
import { A2aCardMarkup } from '../../messages/a2aCardMarkup';
import { TranscriptReporting, type TranscriptEntry } from './toolGroups';
import { SubAgentTraceProjection, type SubAgentTraceInput } from './SubAgentTraceProjection';
import { TracePayload, TracePayloadSerializer } from './TracePayloadSerializer';
import { SupportingReportResolver } from '../../services/SupportingReportResolver';
import { ToolPayloadRepository } from '../../services/ToolPayloadRepository';
import { ToolStepClock } from './ToolStepClock';
import type { SubAgentTraceStatus, TraceIcon, TraceRow, TraceRowKind, TraceRowStatus, TraceTurn } from './traceTypes';

/** Pure renderer-facing projection. It only reads messages and never annotates them. */
export class DetailedTraceProjection {
  static readonly trailingAnchor = '__trace-trailing__';

  constructor(
    private readonly reporting = new TranscriptReporting(),
    private readonly serializer = new TracePayloadSerializer(),
    private readonly subagents = new SubAgentTraceProjection(),
    private readonly toolPayloads = new ToolPayloadRepository(),
    private readonly agentMessages = new A2aCardMarkup(),
    private readonly toolSteps = new ToolStepClock(),
  ) {}

  project(messages: readonly Message[], standardEntries: readonly TranscriptEntry[], subagentInput: SubAgentTraceInput = {}): TraceTurn[] {
    const activities = this.debugActivities(messages, standardEntries);
    const subagents = this.subagents.statusRowsByMessage(messages, subagentInput);
    return this.groups(messages).map((group, index) => {
      const reply = group.find(message => message.kind === 'sulla' || message.kind === 'streaming');
      const last = group[group.length - 1];
      const anchorEntryId = this.anchorFor(reply, last.createdAt, standardEntries);
      const rows = group.flatMap(message => {
        const sourceId = String(message.id);
        const jobRows = subagents.get(sourceId) ?? [];
        subagents.delete(sourceId);
        return [...this.rowsFor(message, sourceId, activities.get(message.id)),
          ...jobRows.map(row => ({ ...row, anchorEntryId }))];
      });
      const usage = this.usage(group);
      const agentSummary = SubAgentTraceProjection.summary(rows.flatMap(row => row.subagent ? [row.status as SubAgentTraceStatus] : []));
      const sourceCount = rows.filter(row => row.kind === 'source').length;
      // A blocked worker or a pending approval in this turn needs the human.
      const waitingOnYou = rows.some(row => (row.subagent && row.status === 'blocked') || (row.kind === 'approval' && row.status === 'waiting'));
      return { id: `trace:${group[0]?.turnId ?? group[0]?.id ?? index}`, anchorEntryId, rows,
        ...(usage ? { usage } : {}), ...(agentSummary ? { agentSummary } : {}),
        ...(sourceCount ? { sourceCount } : {}), ...(waitingOnYou ? { waitingOnYou } : {}) };
    }).filter(turn => turn.rows.length > 0 || Boolean(turn.usage));
  }

  /** Detailed activity as individual timestamped events, never anchored to a reply. */
  projectRows(messages: readonly Message[], standardEntries: readonly TranscriptEntry[], subagentInput: SubAgentTraceInput = {}): TraceRow[] {
    const activities = this.debugActivities(messages, standardEntries);
    const subagents = this.subagents.eventRowsByMessage(messages, subagentInput);
    const messageOrder = new Map(messages.map((message, index) => [String(message.id), index]));
    const rows: TraceRow[] = [];

    for (const message of messages) {
      const ownRows = this.rowsFor(message, String(message.id), activities.get(message.id));
      const jobRows = subagents.get(message.id) ?? [];
      rows.push(...ownRows, ...jobRows.map(row => ({ ...row, anchorEntryId: String(message.id), sourceMessageId: String(message.id) })));
    }

    return rows.map((row, index) => ({ row, index })).sort((left, right) =>
      (left.row.at ?? 0) - (right.row.at ?? 0) ||
      (messageOrder.get(left.row.sourceMessageId ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (messageOrder.get(right.row.sourceMessageId ?? '') ?? Number.MAX_SAFE_INTEGER) ||
      left.index - right.index,
    ).map(item => item.row);
  }

  private groups(messages: readonly Message[]): Message[][] {
    const groups: Message[][] = [];
    let current: Message[] = [];
    for (const message of messages) {
      if (message.kind === 'user' && current.length > 0) { groups.push(current); current = []; }
      current.push(message);
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  /** Keeps the legacy activity-line projection's anchor; the Detailed timeline uses projectRows(). */
  private anchorFor(reply: Message | undefined, groupLastCreatedAt: number, entries: readonly TranscriptEntry[]): string {
    const own = reply && entries.find(entry => entry.sourceId === String(reply.id));
    if (own) return own.id;
    const next = entries.find(entry => entry.createdAt >= groupLastCreatedAt);
    return next?.id ?? DetailedTraceProjection.trailingAnchor;
  }

  private debugActivities(messages: readonly Message[], standardEntries: readonly TranscriptEntry[]): Map<string, string[]> {
    const standardIds = new Set(standardEntries.map(entry => entry.sourceId));
    const result = new Map<string, string[]>();
    for (const entry of this.reporting.entries(messages, 'debug')) {
      if (entry.kind !== 'activity' || standardIds.has(entry.sourceId)) continue;
      const values = result.get(entry.sourceId) ?? [];
      values.push(entry.text);
      result.set(entry.sourceId, values);
    }
    return result;
  }

  private rowsFor(message: Message, anchor: string, activities?: readonly string[]): TraceRow[] {
    // Actual tool records and typed tool thoughts already have faithful rows.
    // Don't render their legacy formatter summaries as a second trace item.
    const hasRecordedToolRow = message.kind === 'tool' ||
      (message.kind === 'thinking' && message.reportingActivity === 'tool' && !message.chatToolActivity);
    const toolActivity = message.kind === 'thinking' && (message.chatToolActivity !== undefined || message.reportingActivity === 'tool');
    const rows = (hasRecordedToolRow ? [] : activities ?? []).map((text, index) => {
      const target = toolActivity ? this.toolSteps.safeLabel(undefined, text) : text;
      return this.row(`${message.id}:activity:${index}`, 'activity', 'Status', target, 'ok', anchor, message.createdAt);
    });
    let projected: TraceRow[];
    switch (message.kind) {
      case 'thinking': projected = rows.concat(this.rowsForThinking(message, anchor)); break;
      case 'tool': projected = rows.concat(this.rowsForTool(message, anchor)); break;
      case 'memory': projected = rows.concat(this.rowsForMemory(message, anchor)); break;
      case 'heartbeat': projected = rows.concat(this.rowsForHeartbeat(message, anchor)); break;
      case 'tool_approval': projected = rows.concat(this.rowsForApproval(message, anchor)); break;
      case 'citation': projected = rows.concat(this.rowsForCitation(message, anchor)); break;
      case 'channel': projected = rows.concat(this.rowsForChannel(message, anchor)); break;
      case 'sulla': case 'streaming': projected = rows.concat(this.rowsForA2a(message, anchor)); break;
      default: projected = rows;
    }
    return projected.map(row => ({ ...row, sourceMessageId: String(message.id) }));
  }

  private rowsForChannel(message: Extract<Message, { kind: 'channel' }>, anchor: string): TraceRow[] {
    const target = `${message.agent} · #${message.channel}`;
    return [{ ...this.row(message.id, 'activity', 'Received', target, 'ok', anchor, message.createdAt), note: message.text }];
  }

  private rowsForA2a(message: Extract<Message, { kind: 'sulla' | 'streaming' }>, anchor: string): TraceRow[] {
    return this.agentMessages.messages(message.text).map((agentMessage, index) => {
      const id = agentMessage.id ? `${message.id}:a2a:${agentMessage.id}` : `${message.id}:a2a:${index}`;
      const target = `${agentMessage.recipient}${agentMessage.targetId ? ` · ${agentMessage.targetId}` : ''}`;
      const status = agentMessage.deliveryStatus === 'failed' ? 'failed' : 'ok';
      const note = agentMessage.reason ? `${agentMessage.body}\n${agentMessage.reason}` : agentMessage.body;
      return { ...this.row(id, 'activity', 'Sent', target, status, anchor, message.createdAt, undefined, agentMessage.deliveryStatus), note };
    });
  }

  private rowsForThinking(message: ThinkingMessage, anchor: string): TraceRow[] {
    return message.thoughts.map((thought, index) => {
      const row = this.row(`${message.id}:thought:${index}`, 'thought', 'Thought', thought, 'ok', anchor, message.createdAt, undefined, undefined,
        new TracePayload([message.thoughts, message.summary], () => this.serializer.serialize({ thoughts: message.thoughts, summary: message.summary })));
      return { ...row, target: thought };
    });
  }

  private rowsForTool(message: ToolMessage, anchor: string): TraceRow[] {
    const step = this.toolSteps.step(message.meta);
    const status: TraceRowStatus = step?.endedAt === undefined && message.status === 'running' ? 'running'
      : message.status === 'error' ? 'failed'
        : message.status === 'running' ? 'running' : 'ok';
    const toolName = message.recordedToolName ?? message.tool;
    const target = this.toolSteps.safeLabel(message.meta, toolName);
    const { input, output, error, desc, meta } = message;
    const payload = new TracePayload([target, message.status, input, output, error, desc, meta, message.toolPayloadRef], () =>
      this.serializer.serialize({ tool: target, status: message.status, input, output, error, description: desc, meta }),
      message.toolPayloadRef ? async() => {
        const event = await this.toolPayloads.load(message.toolPayloadRef!);
        const stored = event && typeof event === 'object' ? event as Record<string, unknown> : {};
        if (!Object.prototype.hasOwnProperty.call(stored, 'result')) throw new Error('The conversation log entry has no complete tool result.');
        return { tool: target, status: message.status, input, output: stored.result, error: typeof stored.error === 'string' ? stored.error : error, description: desc, meta };
      } : undefined);
    const duration = step?.endedAt !== undefined
      ? this.toolSteps.durationLabel(this.toolSteps.elapsedMs(step.startedAt, step.endedAt))
      : step ? undefined : this.duration(meta);
    const row = this.row(message.id, 'tool', status === 'running' ? 'Running' : 'Ran', target, status,
      anchor, step?.startedAt ?? message.createdAt, duration, this.exitCode(meta, output), payload);
    return [this.toolSteps.attachStep({ ...row, icon: this.toolIcon(toolName) }, step)];
  }

  private rowsForMemory(message: MemoryMessage, anchor: string): TraceRow[] {
    return [this.row(message.id, 'memory', message.action, message.memId, 'ok', anchor, message.createdAt, undefined, this.serializer.preview(message.summary), this.serializer.lazy(message))];
  }

  private rowsForHeartbeat(message: HeartbeatMessage, anchor: string): TraceRow[] {
    return [this.row(message.id, 'heartbeat', 'Heartbeat', `${message.intervalMinutes} minute interval`, 'ok', anchor, message.createdAt, undefined, this.serializer.preview(message.text), this.serializer.lazy(message))];
  }

  private rowsForApproval(message: ToolApprovalMessage, anchor: string): TraceRow[] {
    const status: TraceRowStatus = message.decision === 'pending' ? 'waiting'
      : message.decision === 'timed_out' ? 'failed'
        : message.decision;
    return [this.row(message.id, 'approval', 'Approval', message.command, status, anchor, message.createdAt, undefined, message.reason, this.serializer.lazy(message))];
  }

  private rowsForCitation(message: CitationMessage, anchor: string): TraceRow[] {
    // The Read step behind each numbered source, worded like the sources row's own button.
    return message.sources.map((source, index) => ({
      ...this.row(`${message.id}:${index}`, 'source', SupportingReportResolver.webUrl(source) ? 'Read source' : 'Read report',
        source.title, 'ok', anchor, message.createdAt, undefined, source.origin, this.serializer.lazy(source)),
      cite: source.num,
    }));
  }

  private row(id: string, kind: TraceRowKind, verb: string, target: string, status: TraceRowStatus, anchorEntryId: string, at: number, durationLabel?: string, keyArgs?: string, payload?: TracePayload): TraceRow {
    const safeTarget = this.serializer.summary(target);
    return { id, kind, icon: this.iconFor(kind), verb: this.serializer.summary(verb), target: safeTarget, targetIsCode: /(?:[/$\\]|\.(?:ts|js|json|sh)\b|\s--?[a-z])/i.test(safeTarget), status, ...(keyArgs !== undefined ? { keyArgs } : {}), ...(durationLabel ? { durationLabel } : {}), ...(payload ? { payload } : {}), anchorEntryId, at };
  }

  private iconFor(kind: TraceRowKind): TraceIcon {
    switch (kind) {
      case 'thought': return 'thought';
      case 'memory': return 'memory';
      case 'source': return 'read';
      case 'handoff': return 'handoff';
      case 'result': return 'result';
      case 'retry': return 'retry';
      case 'approval': return 'approval';
      case 'tool': return 'shell';
      default: return 'dot';
    }
  }

  private toolIcon(name: string): TraceIcon {
    if (/browser|web|navigate|screenshot/i.test(name)) return 'browser';
    if (/search|grep|find|query/i.test(name)) return 'search';
    if (/read|open|fetch|list|inspect/i.test(name)) return 'read';
    if (/edit|write|patch|replace|update/i.test(name)) return 'edit';
    if (/file|move|copy|save/i.test(name)) return 'file';
    if (/memory/i.test(name)) return 'memory';
    return 'shell';
  }

  /**
   * The exit code the tool actually recorded: meta like "exit 2" first, then the
   * output exec ("Command failed with exit code N:") or exechost ("Command exited N:")
   * writes. No recorded code means none is shown; a successful call is never given
   * a made-up "exit 0".
   */
  private exitCode(meta?: ToolMessage['meta'], output?: string): string | undefined {
    const legacyMeta = typeof meta === 'string' ? meta : undefined;
    const code = legacyMeta?.match(/\bexit(?:\s+code)?\s*:?\s*(-?\d+)/i)?.[1] ??
      output?.match(/\b(?:exit(?:ed)?(?:\s+code)?)\s*:?\s*(-?\d+)/i)?.[1];
    return code !== undefined ? `exit ${ code }` : undefined;
  }

  private duration(meta?: ToolMessage['meta']): string | undefined {
    return typeof meta === 'string' ? meta.match(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/i)?.[0] : undefined;
  }

  private usage(group: readonly Message[]): TraceTurn['usage'] | undefined {
    const replies = group.filter((message): message is SullaMessage => message.kind === 'sulla');
    const totalTokens = replies.reduce((sum, reply) => sum + (reply.tokens ?? 0), 0);
    const model = replies.find(reply => reply.replyAttribution?.model)?.replyAttribution?.model ?? replies.find(reply => reply.model)?.model;
    return model || totalTokens ? { ...(model ? { model: this.serializer.summary(model) } : {}), ...(totalTokens ? { totalTokens } : {}) } : undefined;
  }
}
