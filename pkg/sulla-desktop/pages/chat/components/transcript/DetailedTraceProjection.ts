// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TracePayloadRedactor } from '@pkg/agent/tools/TracePayloadRedactor';
import type { Message, ToolMessage } from '../../models/Message';
import { TranscriptReporting, type TranscriptEntry } from './toolGroups';
import type { TraceRow, TraceRowKind, TraceRowStatus, TraceTurn } from './traceTypes';

/** Pure renderer-facing projection. It only reads messages and never annotates them. */
export class DetailedTraceProjection {
  constructor(private readonly redactor = new TracePayloadRedactor(), private readonly reporting = new TranscriptReporting()) {}

  project(messages: readonly Message[], standardEntries: readonly TranscriptEntry[]): TraceTurn[] {
    const debugEntries = this.debugActivities(messages, standardEntries);
    const groups = this.groups(messages);
    const standard = standardEntries.filter(entry => entry.kind === 'card' || entry.kind === 'activity');
    return groups.map((group, groupIndex) => {
      const lastIndex = messages.indexOf(group[group.length - 1]);
      const reply = group.find(message => message.kind === 'sulla' || message.kind === 'streaming');
      const anchorEntryId = this.anchorFor(reply ?? group[group.length - 1], lastIndex, standard);
      const rows = group.flatMap(message => this.rowsFor(message, anchorEntryId, debugEntries.get(message.id)));
      const usage = this.usage(group);
      return {
        id: `trace:${group[0]?.turnId ?? group[0]?.id ?? groupIndex}`,
        anchorEntryId,
        rows,
        ...(usage ? { usage } : {}),
      };
    }).filter(turn => turn.rows.length > 0 || !!turn.usage);
  }

  private groups(messages: readonly Message[]): Message[][] {
    const groups: Message[][] = [];
    let current: Message[] = [];
    for (const message of messages) {
      if (message.kind === 'user' && current.length) { groups.push(current); current = []; }
      current.push(message);
    }
    if (current.length) groups.push(current);
    return groups;
  }

  private debugActivities(messages: readonly Message[], standardEntries: readonly TranscriptEntry[]): Map<string, string[]> {
    const infoIds = new Set(standardEntries.map(entry => entry.sourceId));
    const map = new Map<string, string[]>();
    // Re-projecting at debug is intentional: these are debug-only activity entries.
    // TranscriptReporting is imported indirectly by the caller's entries; only entries
    // that are absent from the info list can become trace activity rows.
    for (const entry of this.reporting.entries(messages, 'debug')) {
      if (entry.kind !== 'activity' || infoIds.has(entry.sourceId)) continue;
      this.add(map, entry.sourceId, entry.text);
    }
    return map;
  }

  private add(map: Map<string, string[]>, id: string, value: string): void {
    const values = map.get(id) ?? [];
    values.push(value);
    map.set(id, values);
  }

  private anchorFor(message: Message, index: number, entries: readonly TranscriptEntry[]): string {
    const source = entries.find(entry => entry.sourceId === message.id && entry.kind === 'card');
    if (source) return source.id;
    const next = entries.find(entry => entry.createdAt >= message.createdAt);
    return next?.id ?? entries.at(-1)?.id ?? '';
  }

  private rowsFor(message: Message, anchorEntryId: string, activities?: readonly string[]): TraceRow[] {
    const rows: TraceRow[] = [];
    for (const activity of activities ?? []) rows.push(this.row(message.id, 'activity', 'Status', activity, 'ok', anchorEntryId, message.createdAt));
    switch (message.kind) {
      case 'thinking': return rows;
      case 'tool': {
        if (this.isBackgroundBrowse(message)) return rows;
        const denied = this.redactor.isDenied(message.recordedToolName ?? message.tool);
        const target = denied ? TracePayloadRedactor.withheld : (message.desc || message.tool || 'Tool');
        const status: TraceRowStatus = message.status === 'error' ? 'failed' : message.status === 'running' ? 'running' : 'ok';
        rows.push(this.row(message.id, 'tool', status === 'running' ? 'Calling' : 'Used', target, status, anchorEntryId, message.createdAt,
          this.duration((message as ToolMessage & { startedAt?: number }).startedAt, (message as ToolMessage & { completedAt?: number }).completedAt, message.meta), denied ? undefined : message.input,
          denied ? TracePayloadRedactor.withheld : this.payload(message, message.recordedToolName ?? message.tool)));
        return rows;
      }
      case 'memory': rows.push(this.row(message.id, 'memory', message.action, message.memId, 'ok', anchorEntryId, message.createdAt, undefined, undefined, this.payload(message))); return rows;
      case 'heartbeat': rows.push(this.row(message.id, 'heartbeat', 'Heartbeat', `${message.intervalMinutes} minute interval`, 'ok', anchorEntryId, message.createdAt, undefined, undefined, this.payload(message))); return rows;
      case 'subagent_exchange': rows.push(this.row(message.id, message.direction === 'to_agent' ? 'handoff' : 'activity', message.direction === 'to_agent' ? 'Handed off to' : 'Received from', message.label, this.status(message.status), anchorEntryId, message.createdAt, undefined, message.summary, this.payload(message))); return rows;
      case 'tool_approval': rows.push(this.row(message.id, 'approval', 'Approval', message.command, message.decision === 'pending' ? 'waiting' : message.decision === 'approved' ? 'approved' : 'failed', anchorEntryId, message.createdAt, undefined, undefined, this.payload(message))); return rows;
      case 'citation': return message.sources.map((source, index) => this.row(`${message.id}:${index}`, 'source', 'Source', source.title, 'ok', anchorEntryId, message.createdAt, undefined, source.origin, this.redactor.serialize(source)));
      default: return rows;
    }
  }

  private row(id: string, kind: TraceRowKind, verb: string, target: string, status: TraceRowStatus, anchorEntryId: string, at: number,
    durationLabel?: string, keyArgs?: string, rawPayload?: string, note?: string): TraceRow {
    const safeTarget = this.redactor.redactText(String(target));
    return { id, kind, verb: this.redactor.redactText(verb), target: safeTarget, targetIsCode: /(?:[/$\\]|\.(?:ts|js|json|sh)\b|\s--?[a-z])/i.test(safeTarget), status,
      ...(keyArgs ? { keyArgs: this.redactor.redactText(keyArgs) } : {}), ...(durationLabel ? { durationLabel: this.redactor.redactText(durationLabel) } : {}),
      ...(rawPayload ? { rawPayload: this.redactor.redactText(rawPayload) } : {}), ...(note ? { note: this.redactor.redactText(note) } : {}), anchorEntryId, at };
  }

  private payload(message: Message, toolName?: string): string {
    return this.redactor.serialize(message, toolName);
  }

  private status(status: string): TraceRowStatus { return status === 'running' ? 'running' : status === 'done' ? 'ok' : 'failed'; }
  private duration(startedAt?: number, completedAt?: number, meta?: string): string | undefined {
    if (typeof startedAt === 'number' && typeof completedAt === 'number') return `${Math.max(0, completedAt - startedAt)}ms`;
    return meta?.match(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/i)?.[0];
  }
  private isBackgroundBrowse(message: ToolMessage): boolean { return /background[_ -]?browse/i.test(message.recordedToolName ?? message.tool); }
  private usage(group: readonly Message[]): TraceTurn['usage'] | undefined {
    const replies = group.filter((message): message is Extract<Message, { kind: 'sulla' }> => message.kind === 'sulla');
    const totalTokens = replies.reduce((sum, reply) => sum + (reply.tokens ?? 0), 0);
    const model = replies.find(reply => reply.replyAttribution?.model)?.replyAttribution?.model ?? replies.find(reply => reply.model)?.model;
    return model || totalTokens ? { ...(model ? { model: this.redactor.redactText(model) } : {}), ...(totalTokens ? { totalTokens } : {}) } : undefined;
  }
}
