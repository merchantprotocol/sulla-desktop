// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { DecisionRecord, DecisionRouteEntry, DecisionRouteHistoryEntry } from '@pkg/shared/decisions';

export type DecisionRouteTurn = 'yours' | 'with-agent' | 'settled';

export interface DecisionRouteTrailRow {
  key: string;
  time: string;
  timestamp?: number;
  actorLabel: string;
  actorInitial: string;
  actorKind: 'agent' | 'human';
  actionLabel: string;
  note?: string;
  current?: boolean;
}

export interface DecisionRoutePresentation {
  hasRoute: boolean;
  turn: DecisionRouteTurn;
  holderLabel?: string;
  holderKind: 'agent' | 'human';
  holderInitial: string;
  settledTone?: 'success' | 'warning' | 'muted' | 'neutral';
  holderLine: string;
  secondaryLine?: string;
  compactLine: string;
  compactSecondaryLine?: string;
  requesterLabel?: string;
  requesterInitial: string;
  answeredByLabel?: string;
  answerSummary?: string;
  trail: readonly DecisionRouteTrailRow[];
}

export interface DecisionRouteClock {
  now(): number;
}

export type DecisionRouteHumanName = () => string;

interface LabeledRouteEntry extends DecisionRouteEntry { label?: string }

/** Converts persisted escalation state to neutral renderer copy; it never mutates records. */
export class DecisionRoutePresenter {
  constructor(
    private readonly clock: DecisionRouteClock,
    private readonly readHumanName: DecisionRouteHumanName = () => '',
  ) {}

  present(record: DecisionRecord): DecisionRoutePresentation {
    const now = this.clock.now();
    const active = DecisionAttention.active(record, now);
    const expired = !active && record.kind === 'approval' && ['pending', 'deferred'].includes(record.status) && record.expiresAt <= now;
    const route = record.route;
    const holder = route?.chain[route.holderIndex];
    const turn: DecisionRouteTurn = !active ? 'settled' : holder?.kind === 'agent' ? 'with-agent' : 'yours';
    const deadlineAt = route?.holderDeadline ?? record.expiresAt;
    const deadline = this.formatTime(deadlineAt);
    const holderLabel = holder ? this.entryLabel(holder) : undefined;
    const requesterLabel = record.requestedBy?.label?.trim() || (record.requestedBy ? this.agentLabel(record.requestedBy.agentId) : this.agentLabel(record.channel || 'Sulla'));
    const answerer = record.answeredBy;
    const answererEntry = answerer?.kind === 'agent'
      ? (answerer.threadId ? this.entryForThread(record, answerer.threadId) : route?.chain.find(entry => entry.agentId === answerer.agentId))
      : undefined;
    const holderKind: 'agent' | 'human' = turn === 'with-agent' || answerer?.kind === 'agent' ? 'agent' : 'human';
    const holderInitial = holderKind === 'agent'
      ? this.actorInitial(
        turn === 'with-agent' ? holderLabel || 'agent' : answerer?.kind === 'agent' ? answerer.label?.trim() || (answererEntry ? this.entryLabel(answererEntry) : this.agentLabel(answerer.agentId || 'agent')) : 'agent',
        'agent',
        turn === 'with-agent' ? holder?.agentId : answererEntry?.agentId || (answerer?.kind === 'agent' ? answerer.agentId : undefined),
      )
      : this.humanInitial();
    const tail = holder && route ? this.tailLabel(route.chain, route.holderIndex) : '';
    const answeredByLabel = this.answererLabel(record);
    const line = this.holderLine(record, turn, holderLabel, deadline, answeredByLabel, expired);
    const secondary = this.secondaryLine(record, turn, route, deadlineAt, tail);

    return {
      hasRoute: !!route,
      turn,
      holderLabel,
      holderKind,
      holderInitial,
      settledTone: this.settledTone(record, turn, expired),
      holderLine: line,
      secondaryLine: secondary,
      compactLine: turn === 'with-agent' && holderLabel ? `With ${holderLabel}` : turn === 'yours' ? 'Your turn' : line,
      compactSecondaryLine: turn === 'with-agent'
        ? [deadline ? `until ${deadline}` : '', tail].filter(Boolean).join(' · ')
        : secondary,
      requesterLabel,
      requesterInitial: this.actorInitial(requesterLabel, 'agent', record.requestedBy?.agentId || record.channel),
      answeredByLabel,
      answerSummary: record.answers?.map(answer => answer.selected.join(', ')).filter(Boolean).join(' · ') || undefined,
      trail: route ? this.trailRows(record, route, turn, holderLabel, deadline, requesterLabel, expired) : [],
    };
  }

  group(records: readonly DecisionRecord[]): {
    yourTurn: { record: DecisionRecord; presentation: DecisionRoutePresentation }[];
    withAgent: { record: DecisionRecord; presentation: DecisionRoutePresentation }[];
    settled: { record: DecisionRecord; presentation: DecisionRoutePresentation }[];
  } {
    const groups = { yourTurn: [], withAgent: [], settled: [] } as {
      yourTurn: { record: DecisionRecord; presentation: DecisionRoutePresentation }[];
      withAgent: { record: DecisionRecord; presentation: DecisionRoutePresentation }[];
      settled: { record: DecisionRecord; presentation: DecisionRoutePresentation }[];
    };
    for (const record of records) {
      if (!record.route) continue;
      const presentation = this.present(record);
      groups[presentation.turn === 'yours' ? 'yourTurn' : presentation.turn === 'with-agent' ? 'withAgent' : 'settled'].push({ record, presentation });
    }
    for (const recordsInGroup of Object.values(groups)) recordsInGroup.sort((a, b) => b.record.createdAt - a.record.createdAt || b.record.id.localeCompare(a.record.id));
    return groups;
  }

  private holderLine(record: DecisionRecord, turn: DecisionRouteTurn, holder: string | undefined, deadline: string, answeredBy: string | undefined, expired: boolean): string {
    if (turn === 'with-agent') return `With ${holder || 'an agent'}${deadline ? ` until ${deadline}` : ''}`;
    if (turn === 'yours') return `Your turn: waiting for your ${record.kind === 'question' ? 'answer' : 'approval'}`;
    if (expired && ['pending', 'deferred'].includes(record.status)) return 'Expired';
    if (answeredBy) return answeredBy;
    if (record.status === 'expired') return 'Expired';
    return `${record.status.charAt(0).toUpperCase()}${record.status.slice(1)}`;
  }

  private secondaryLine(record: DecisionRecord, turn: DecisionRouteTurn, route: DecisionRecord['route'], deadlineAt: number, tail: string): string | undefined {
    if (turn === 'with-agent') return tail ? `· ${tail}` : undefined;
    if (turn === 'yours') return `Expires ${this.formatTime(record.expiresAt)}`;
    const finalEvent = route?.history.at(-1);
    const time = finalEvent ? this.formatTime(finalEvent.at) : undefined;
    if (record.answeredBy?.kind === 'agent' && record.status === 'answered') return [time, 'you were not asked'].filter(Boolean).join(' · ');
    if (record.status === 'denied') return [time, 'final'].filter(Boolean).join(' · ');
    return time || (record.status === 'expired' ? this.formatTime(deadlineAt) : undefined);
  }

  private answererLabel(record: DecisionRecord): string | undefined {
    if (!record.answeredBy || !['answered', 'approved', 'denied'].includes(record.status)) return undefined;
    const actor = record.answeredBy;
    const chainEntry = actor.kind === 'agent' && (actor.threadId ? this.entryForThread(record, actor.threadId) : record.route?.chain.find(entry => entry.agentId === actor.agentId));
    const label = actor.kind === 'human' ? 'you' : actor.label?.trim() || (chainEntry ? this.entryLabel(chainEntry) : this.agentLabel(actor.agentId || 'agent'));
    const action = record.status === 'approved' ? 'Approved' : record.status === 'denied' ? 'Denied' : 'Answered';
    return `${action} by ${label}`;
  }

  private settledTone(record: DecisionRecord, turn: DecisionRouteTurn, expired: boolean): DecisionRoutePresentation['settledTone'] {
    if (turn !== 'settled') return undefined;
    if (expired || record.status === 'expired' || record.attention === 'dismissed') return 'muted';
    if (record.status === 'denied') return 'warning';
    if (record.answeredBy?.kind === 'agent') return 'neutral';
    return ['answered', 'approved'].includes(record.status) ? 'success' : 'neutral';
  }

  private trailRows(record: DecisionRecord, route: NonNullable<DecisionRecord['route']>, turn: DecisionRouteTurn, holderLabel: string | undefined, deadline: string, requesterLabel: string, expired: boolean): DecisionRouteTrailRow[] {
    const rows: DecisionRouteTrailRow[] = [{
      key: `asked-${record.id}`,
      time: this.formatTime(record.createdAt),
      timestamp: record.createdAt,
      actorLabel: requesterLabel,
      actorInitial: this.actorInitial(requesterLabel, 'agent', record.requestedBy?.agentId || record.channel),
      actorKind: 'agent',
      actionLabel: 'asked',
    }];
    for (const [index, item] of route.history.entries()) {
      const heldSince = index ? route.history[index - 1].at : route.deliveredAt ?? record.createdAt;
      rows.push(this.historyRow(record, route.chain, item, index, item.at - heldSince));
    }
    if (turn !== 'settled') {
      const isHuman = route.chain[route.holderIndex]?.kind === 'human';
      rows.push({
        key: `current-${record.id}`,
        time: 'now',
        actorLabel: isHuman ? this.humanLabel() : holderLabel || 'An agent',
        actorKind: isHuman ? 'human' : 'agent',
        actionLabel: isHuman ? `Your turn until ${deadline}` : `With ${holderLabel || 'an agent'} until ${deadline}`,
        current: true,
      });
    } else if (expired || record.status === 'expired') {
      const holder = route.chain[route.holderIndex];
      const actorKind = holder?.kind ?? 'human';
      const actorLabel = actorKind === 'human' ? this.humanLabel() : this.entryLabel(holder);
      rows.push({
        key: `expired-${record.id}`,
        time: this.formatTime(record.expiresAt),
        timestamp: record.expiresAt,
        actorLabel,
        actorInitial: this.actorInitial(actorLabel, actorKind, holder?.agentId),
        actorKind,
        actionLabel: record.kind === 'approval' ? 'expired; the command did not run' : 'expired without an answer',
      });
    }
    return rows;
  }

  private historyRow(record: DecisionRecord, chain: DecisionRouteEntry[], item: DecisionRouteHistoryEntry, index: number, heldMs: number): DecisionRouteTrailRow {
    const entry = chain.find(candidate => candidate.threadId === item.threadId && candidate.agentId === item.agentId)
      ?? chain.find(candidate => candidate.agentId === item.agentId);
    const actorKind = entry?.kind ?? (item.agentId === 'human' ? 'human' : 'agent');
    const actorLabel = actorKind === 'human' ? this.humanLabel() : this.entryLabel(entry, item.agentId);
    const actionLabel = item.action === 'passed' ? `passed it up after ${this.formatDuration(heldMs)}`
      : item.action === 'timeout' ? `ran out of time after ${this.formatDuration(heldMs)}; moved up with no note`
      : item.action === 'unavailable' ? `was unavailable after ${this.formatDuration(heldMs)}; moved up with no note`
      : item.action === 'denied' ? 'denied it'
      : 'answered';
    return {
      key: `${record.id}-${item.threadId}-${item.at}-${index}`,
      time: this.formatTime(item.at),
      timestamp: item.at,
      actorLabel,
      actorInitial: this.actorInitial(actorLabel, actorKind, item.agentId),
      actorKind,
      actionLabel,
      note: this.sanitizeNote(item.note),
    };
  }

  private tailLabel(chain: DecisionRouteEntry[], holderIndex: number): string {
    const next = chain.slice(holderIndex + 1).map(entry => this.entryLabel(entry));
    return next.length ? `then ${next.join(', then ')}` : '';
  }

  private entryLabel(entry: DecisionRouteEntry | undefined, fallback?: string): string {
    if (!entry) return this.agentLabel(fallback || 'agent');
    if (entry.kind === 'human') return 'you';
    const labeled = (entry as LabeledRouteEntry).label?.trim();
    return labeled || this.agentLabel(entry.agentId);
  }

  private entryForThread(record: DecisionRecord, threadId: string | undefined): DecisionRouteEntry | undefined {
    return record.route?.chain.find(entry => entry.threadId === threadId);
  }

  private agentLabel(agentId: string): string {
    return agentId.split(/[-_\s]+/).filter(Boolean).map(word => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ');
  }

  private actorInitial(label: string, kind: 'agent' | 'human', agentId?: string): string {
    if (kind === 'human') return this.humanInitial();
    const parts = (agentId || label).split(/[-_\s]+/).filter(Boolean);
    return (parts[0] === 'codex' ? parts[1] : parts[0])?.[0]?.toUpperCase() || 'A';
  }

  private humanLabel(): string {
    return this.readHumanName().trim() || 'You';
  }

  private humanInitial(): string {
    return this.humanLabel().split(/\s+/).find(Boolean)?.[0]?.toUpperCase() || 'Y';
  }

  private formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
  }

  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
    const minutes = Math.floor(seconds / 60);
    if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  private sanitizeNote(note?: string): string | undefined {
    if (!note) return undefined;
    const plain = note
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/(?:https?|ftp):\/\/\S+|mailto:\S+|www\.\S+/gi, '')
      .replace(/[`*_~]/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*(?:[-+]\s+|\d+\.\s+)/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    return plain || undefined;
  }
}
