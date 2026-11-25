// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Message, ToolMessage, ThinkingMessage, MemoryMessage, HeartbeatMessage, ToolApprovalMessage, CitationMessage, SullaMessage } from '../../models/Message';
import { TranscriptReporting, type TranscriptEntry } from './toolGroups';
import { SubAgentTraceProjection, type SubAgentTraceInput } from './SubAgentTraceProjection';
import { TracePayload, TracePayloadSerializer } from './TracePayloadSerializer';
import { SupportingReportResolver } from '../../services/SupportingReportResolver';
import { ToolPayloadRepository } from '../../services/ToolPayloadRepository';
import type { SubAgentTraceStatus, TraceRow, TraceRowKind, TraceRowStatus, TraceTurn } from './traceTypes';

/** Pure renderer-facing projection. It only reads messages and never annotates them. */
export class DetailedTraceProjection {
  static readonly trailingAnchor = '__trace-trailing__';

  constructor(private readonly reporting = new TranscriptReporting(), private readonly serializer = new TracePayloadSerializer(), private readonly subagents = new SubAgentTraceProjection(), private readonly toolPayloads = new ToolPayloadRepository()) {}

  project(messages: readonly Message[], standardEntries: readonly TranscriptEntry[], subagentInput: SubAgentTraceInput = {}): TraceTurn[] {
    const activities = this.debugActivities(messages, standardEntries);
    const subagents = this.subagents.rowsByMessage(messages, subagentInput);
    return this.groups(messages).map((group, index) => {
      const reply = group.find(message => message.kind === 'sulla' || message.kind === 'streaming');
      const last = group[group.length - 1];
      const anchorEntryId = this.anchorFor(reply, last.createdAt, standardEntries);
      const rows = group.flatMap(message => {
        const jobRows = subagents.get(message.id) ?? [];
        subagents.delete(message.id);
        return [...this.rowsFor(message, anchorEntryId, activities.get(message.id)),
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

  byAnchor(turns: readonly TraceTurn[]): Map<string, TraceTurn[]> {
    const anchors = new Map<string, TraceTurn[]>();
    for (const turn of turns) {
      const siblings = anchors.get(turn.anchorEntryId);
      if (siblings) siblings.push(turn);
      else anchors.set(turn.anchorEntryId, [turn]);
    }
    return anchors;
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

  private anchorFor(reply: Message | undefined, groupLastCreatedAt: number, entries: readonly TranscriptEntry[]): string {
    const own = reply && entries.find(entry => entry.sourceId === reply.id);
    if (own) return own.id;
    const next = entries.find(entry => entry.createdAt >= groupLastCreatedAt);
    return next?.id ?? DetailedTraceProjection.trailingAnchor;
  }

  private rowsFor(message: Message, anchor: string, activities?: readonly string[]): TraceRow[] {
    // Actual tool records and typed tool thoughts already have faithful rows.
    // Don't render their legacy formatter summaries as a second trace item.
    const hasRecordedToolRow = message.kind === 'tool' ||
      (message.kind === 'thinking' && message.reportingActivity === 'tool' && !message.chatToolActivity);
    const rows = (hasRecordedToolRow ? [] : activities ?? []).map((text, index) => this.row(`${message.id}:activity:${index}`, 'activity', 'Status', text, 'ok', anchor, message.createdAt));
    switch (message.kind) {
      case 'thinking': return rows.concat(this.rowsForThinking(message, anchor));
      case 'tool': return rows.concat(this.rowsForTool(message, anchor));
      case 'memory': return rows.concat(this.rowsForMemory(message, anchor));
      case 'heartbeat': return rows.concat(this.rowsForHeartbeat(message, anchor));
      case 'tool_approval': return rows.concat(this.rowsForApproval(message, anchor));
      case 'citation': return rows.concat(this.rowsForCitation(message, anchor));
      default: return rows;
    }
  }

  private rowsForThinking(message: ThinkingMessage, anchor: string): TraceRow[] {
    return message.thoughts.map((thought, index) => this.row(`${message.id}:thought:${index}`, 'thought', 'Thought', thought, 'ok', anchor, message.createdAt, undefined, undefined, new TracePayload([message.thoughts, message.summary], () => this.serializer.serialize({ thoughts: message.thoughts, summary: message.summary }))));
  }

  private rowsForTool(message: ToolMessage, anchor: string): TraceRow[] {
    const status: TraceRowStatus = message.status === 'error' ? 'failed' : message.status === 'running' ? 'running' : 'ok';
    const target = message.recordedToolName ?? message.tool;
    const { input, output, error, desc, meta } = message;
    const payload = new TracePayload([target, message.status, input, output, error, desc, meta, message.toolPayloadRef], () =>
      this.serializer.serialize({ tool: target, status: message.status, input, output, error, description: desc, meta }),
      message.toolPayloadRef ? async() => {
        const event = await this.toolPayloads.load(message.toolPayloadRef!);
        const stored = event && typeof event === 'object' ? event as Record<string, unknown> : {};
        if (!Object.prototype.hasOwnProperty.call(stored, 'result')) throw new Error('The conversation log entry has no complete tool result.');
        return { tool: target, status: message.status, input, output: stored.result, error: typeof stored.error === 'string' ? stored.error : error, description: desc, meta };
      } : undefined);
    const shell = this.shellCommand(message);
    if (shell) {
      // "Ran <command>  <tool> · exit N": the real tool name stays on the line (no-redaction rule).
      const args = [target, this.exitCode(meta, output)].filter(Boolean).join(' · ');
      return [{ ...this.row(message.id, 'tool', status === 'running' ? 'Running' : 'Ran', shell, status,
        anchor, message.createdAt, this.duration(meta), args, payload),
        // Keep the command's own lines and spacing; only trim the ends.
        target: shell.trim(), targetIsCode: true }];
    }
    return [this.row(message.id, 'tool', status === 'running' ? 'Calling' : 'Used', target, status,
      anchor, message.createdAt, this.duration(meta), this.serializer.preview(input), payload)];
  }

  private rowsForMemory(message: MemoryMessage, anchor: string): TraceRow[] {
    return [this.row(message.id, 'memory', message.action, message.memId, 'ok', anchor, message.createdAt, undefined, this.serializer.preview(message.summary), this.serializer.lazy(message))];
  }

  private rowsForHeartbeat(message: HeartbeatMessage, anchor: string): TraceRow[] {
    return [this.row(message.id, 'heartbeat', 'Heartbeat', `${message.intervalMinutes} minute interval`, 'ok', anchor, message.createdAt, undefined, this.serializer.preview(message.text), this.serializer.lazy(message))];
  }

  private rowsForApproval(message: ToolApprovalMessage, anchor: string): TraceRow[] {
    const status: TraceRowStatus = message.decision === 'pending' ? 'waiting' : message.decision === 'approved' ? 'approved' : 'failed';
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
    return { id, kind, verb: this.serializer.summary(verb), target: safeTarget, targetIsCode: /(?:[/$\\]|\.(?:ts|js|json|sh)\b|\s--?[a-z])/i.test(safeTarget), status, ...(keyArgs ? { keyArgs: this.serializer.summary(keyArgs) } : {}), ...(durationLabel ? { durationLabel } : {}), ...(payload ? { payload } : {}), anchorEntryId, at };
  }

  /** The full command of a shell tool call, or undefined for any other tool. */
  private shellCommand(message: ToolMessage): string | undefined {
    const name = message.recordedToolName ?? message.tool;
    if (message.tool !== 'Bash' && !/^(?:bash|exec|exechost|(?:meta\/)?exec(?:host)?)$/i.test(name)) return undefined;
    const input = message.input?.trim();
    if (!input) return undefined;
    try {
      const parsed = JSON.parse(input) as { command?: unknown };
      return typeof parsed?.command === 'string' && parsed.command ? parsed.command : undefined;
    } catch {
      return input;
    }
  }

  /**
   * The exit code the tool actually recorded: meta like "exit 2" first, then the
   * output exec ("Command failed with exit code N:") or exechost ("Command exited N:")
   * writes. No recorded code means none is shown; a successful call is never given
   * a made-up "exit 0".
   */
  private exitCode(meta?: string, output?: string): string | undefined {
    const code = meta?.match(/\bexit(?:\s+code)?\s*:?\s*(-?\d+)/i)?.[1] ??
      output?.match(/\b(?:exit(?:ed)?(?:\s+code)?)\s*:?\s*(-?\d+)/i)?.[1];
    return code !== undefined ? `exit ${ code }` : undefined;
  }

  private duration(meta?: string): string | undefined {
    return meta?.match(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/i)?.[0];
  }

  private usage(group: readonly Message[]): TraceTurn['usage'] | undefined {
    const replies = group.filter((message): message is SullaMessage => message.kind === 'sulla');
    const totalTokens = replies.reduce((sum, reply) => sum + (reply.tokens ?? 0), 0);
    const model = replies.find(reply => reply.replyAttribution?.model)?.replyAttribution?.model ?? replies.find(reply => reply.model)?.model;
    return model || totalTokens ? { ...(model ? { model: this.serializer.summary(model) } : {}), ...(totalTokens ? { totalTokens } : {}) } : undefined;
  }
}
