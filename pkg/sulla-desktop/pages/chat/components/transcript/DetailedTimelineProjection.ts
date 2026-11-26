// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Message, SullaMessage, UserMessage } from '../../models/Message';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import { DetailedTraceProjection } from './DetailedTraceProjection';
import type { TraceRow } from './traceTypes';
import { TranscriptReporting, type TranscriptEntry } from './toolGroups';

export interface DetailedTimelineHeader {
  agent: string;
  time: string;
  model?: string;
  metadata: string[];
}

export type DetailedTimelineItem =
  | { id: string; at: number; kind: 'header'; header: DetailedTimelineHeader }
  | { id: string; at: number; kind: 'message'; entry: TranscriptEntry; streamingParagraphBreak: boolean }
  | { id: string; at: number; kind: 'trace'; row: TraceRow }
  | { id: string; at: number; kind: 'waiting'; message: UserMessage; since: number };

interface TimelineEvent {
  item: DetailedTimelineItem;
  sourceOrder: number;
  localOrder: number;
}

export interface DetailedTimelineSegment {
  id: string;
  leading: DetailedTimelineItem[];
  header?: Extract<DetailedTimelineItem, { kind: 'header' }>;
  items: DetailedTimelineItem[];
}

/** Groups the already-ordered stream only into visual turn sections, never into a work summary. */
export class DetailedTimelineSegmenter {
  segment(items: readonly DetailedTimelineItem[]): DetailedTimelineSegment[] {
    const segments: DetailedTimelineSegment[] = [];
    let leading: DetailedTimelineItem[] = [];
    let header: Extract<DetailedTimelineItem, { kind: 'header' }> | undefined;
    let content: DetailedTimelineItem[] = [];
    const flush = (): void => {
      if (!leading.length && !header && !content.length) return;
      segments.push({ id: header?.id ?? leading[0]?.id ?? content[0]?.id ?? `segment:${segments.length}`,
        leading, ...(header ? { header } : {}), items: content });
      leading = [];
      header = undefined;
      content = [];
    };

    for (const item of items) {
      if (this.isUserMessage(item)) {
        if (header || content.length || leading.length) flush();
        leading.push(item);
        continue;
      }
      if (item.kind === 'header') {
        if (header || content.length) flush();
        header = item;
        continue;
      }
      content.push(item);
    }
    flush();
    return segments;
  }

  private isUserMessage(item: DetailedTimelineItem): item is Extract<DetailedTimelineItem, { kind: 'message' }> {
    return item.kind === 'message' && item.entry.kind === 'card' && item.entry.message.kind === 'user';
  }
}

/** Merges standard cards and detailed-only rows without moving an event to its reply. */
export class DetailedTimelineProjection {
  constructor(
    private readonly traceProjection = new DetailedTraceProjection(),
    private readonly reporting = new TranscriptReporting(),
  ) {}

  project(
    messages: readonly Message[],
    standardEntries: readonly TranscriptEntry[],
    agents?: readonly AgentStateRow[],
    waiting?: { message: UserMessage; since: number } | null,
  ): DetailedTimelineItem[] {
    const ordered = messages.map((message, order) => ({ message, order }))
      .sort((left, right) => left.message.createdAt - right.message.createdAt || left.order - right.order);
    const rows = this.traceProjection.projectRows(messages, standardEntries, { agents });
    const entriesBySource = this.entriesBySource(standardEntries);
    const rowsBySource = this.rowsBySource(rows);
    const entryIndexById = new Map(standardEntries.map((entry, index) => [entry.id, index]));
    const groups = this.groups(ordered.map(item => item.message));
    const orderById = new Map(ordered.map((item, index) => [String(item.message.id), index]));
    const result: DetailedTimelineItem[] = [];

    for (const group of groups) {
      const groupIds = new Set(group.map(message => String(message.id)));
      const groupRows = group.flatMap(message => rowsBySource.get(String(message.id)) ?? []);
      const userMessages = group.filter((message): message is UserMessage => message.kind === 'user');

      for (const message of userMessages) {
        for (const entry of entriesBySource.get(String(message.id)) ?? []) {
          result.push({ id: `message:${entry.id}`, at: entry.createdAt, kind: 'message', entry,
            streamingParagraphBreak: this.streamingBreak(standardEntries, entryIndexById, entry.id) });
        }
      }

      const hasTurnContent = group.some(message => message.kind !== 'user') ||
        (waiting !== null && waiting !== undefined && groupIds.has(String(waiting.message.id))) || groupRows.length > 0;
      if (hasTurnContent) result.push({
        id: `header:${String(group[0]?.turnId ?? group[0]?.id ?? result.length)}`,
        at: userMessages[0]?.createdAt ?? group[0]?.createdAt ?? 0,
        kind: 'header',
        header: this.header(group, groupRows, waiting && groupIds.has(String(waiting.message.id)) ? waiting : undefined),
      });

      const events: TimelineEvent[] = [];
      let localOrder = 0;
      for (const message of group) {
        const sourceId = String(message.id);
        const sourceOrder = orderById.get(sourceId) ?? Number.MAX_SAFE_INTEGER;
        if (message.kind !== 'user') {
          const sourceRows = rowsBySource.get(sourceId) ?? [];
          for (const entry of entriesBySource.get(sourceId) ?? []) {
            // TranscriptReporting's debug activity text is replaced by the full trace row.
            if (this.isRepresentedByTrace(entry, sourceRows)) continue;
            events.push({ item: { id: `message:${entry.id}`, at: entry.createdAt, kind: 'message', entry,
              streamingParagraphBreak: this.streamingBreak(standardEntries, entryIndexById, entry.id) }, sourceOrder, localOrder: localOrder++ });
          }
          for (const row of sourceRows) events.push({ item: { id: `trace:${row.id}`, at: row.at ?? message.createdAt, kind: 'trace', row }, sourceOrder, localOrder: localOrder++ });
        }
      }

      if (waiting && groupIds.has(String(waiting.message.id))) {
        const newestUserAt = userMessages[userMessages.length - 1]?.createdAt ?? waiting.since;
        const at = Math.max(waiting.since, newestUserAt);
        events.push({ item: { id: `waiting:${String(waiting.message.id)}:${waiting.since}`, at,
          kind: 'waiting', message: waiting.message, since: waiting.since },
        sourceOrder: orderById.get(String(waiting.message.id)) ?? Number.MAX_SAFE_INTEGER, localOrder: localOrder++ });
      }

      events.sort((left, right) => left.item.at - right.item.at || left.sourceOrder - right.sourceOrder || left.localOrder - right.localOrder);
      result.push(...events.map(event => event.item));
    }

    return result.map((item, order) => ({ item, order }))
      .sort((left, right) => left.item.at - right.item.at || left.order - right.order)
      .map(({ item }) => item);
  }

  private entriesBySource(entries: readonly TranscriptEntry[]): Map<string, TranscriptEntry[]> {
    const result = new Map<string, TranscriptEntry[]>();
    for (const entry of entries) {
      const source = result.get(entry.sourceId) ?? [];
      source.push(entry);
      result.set(entry.sourceId, source);
    }
    return result;
  }

  private rowsBySource(rows: readonly TraceRow[]): Map<string, TraceRow[]> {
    const result = new Map<string, TraceRow[]>();
    for (const row of rows) {
      const id = row.sourceMessageId;
      if (!id) continue;
      const source = result.get(id) ?? [];
      source.push(row);
      result.set(id, source);
    }
    return result;
  }

  private isRepresentedByTrace(entry: TranscriptEntry, rows: readonly TraceRow[]): boolean {
    if (entry.kind === 'activity') return rows.some(row => row.kind === 'tool');
    switch (entry.message.kind) {
      case 'channel': return rows.some(row => row.verb === 'Received');
      case 'memory': return rows.some(row => row.kind === 'memory');
      case 'heartbeat': return rows.some(row => row.kind === 'heartbeat');
      default: return false;
    }
  }

  private groups(messages: readonly Message[]): Message[][] {
    const result: Message[][] = [];
    let current: Message[] = [];
    for (const message of messages) {
      if (message.kind === 'user' && current.length) { result.push(current); current = []; }
      current.push(message);
    }
    if (current.length) result.push(current);
    return result;
  }

  private streamingBreak(entries: readonly TranscriptEntry[], indexById: ReadonlyMap<string, number>, id: string): boolean {
    const index = indexById.get(id);
    return index !== undefined && this.reporting.isStreamingContinuation(entries, index);
  }

  private header(group: readonly Message[], rows: readonly TraceRow[], waiting?: { message: UserMessage; since: number }): DetailedTimelineHeader {
    const replies = group.filter((message): message is SullaMessage => message.kind === 'sulla');
    const attributed = replies.find(message => message.replyAttribution?.model || message.replyAttribution?.agent);
    const reply = attributed ?? replies[0];
    const firstEventAt = group.find(message => message.kind !== 'user')?.createdAt ?? waiting?.since ?? group[0]?.createdAt ?? 0;
    const tokens = replies.reduce((sum, message) => sum + (message.tokens ?? 0), 0);
    const sources = rows.filter(row => row.kind === 'source').length;
    const metadata = [
      ...(tokens ? [`${tokens.toLocaleString()} tokens`] : []),
      ...(rows.length ? [`${rows.length} steps`] : []),
      ...(sources ? [`${sources} ${sources === 1 ? 'source' : 'sources'} cited`] : []),
      ...(rows.some(row => (row.kind === 'approval' && row.status === 'waiting') ||
        (row.subagent && row.status === 'blocked')) ? ['waiting on you'] : []),
    ];
    return {
      agent: reply?.replyAttribution?.agent || 'Sulla',
      time: new Date(firstEventAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      ...(reply?.replyAttribution?.model || reply?.model ? { model: reply.replyAttribution?.model ?? reply.model } : {}),
      metadata,
    };
  }
}
