// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { resultActivity, type ResultActivity } from './resultActivity';
import { blockedDetail, parkedActivity, quietDetail, runningDetail, waitTarget } from './threadActivity';
import { WorkSteps } from './workSteps';

import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { DecisionRecord } from '@pkg/shared/decisions';

import type { Message, ProactiveMessage } from '../models/Message';

/**
 * What the side dock's tabs show, derived from data the chat already has:
 * result cards, decisions and the agent state rows. Plain code, no model.
 */

export interface ResultEntry { item: AgentResultItem; messageId: string }
export interface ResultSection { key: string; title: string; items: ResultEntry[] }
export interface ResultGroups {
  pinned:      { messageId: string; text: string }[];
  /** Failed or blocked: always first. */
  needsAction: ResultEntry[];
  /** Everything else by kind of work (Shipped, Reviews, Fixes, Builds, QA, Other). */
  sections:    ResultSection[];
}

const KINDS: { key: string; title: string; test: RegExp; purpose?: AgentResultItem['purpose'] }[] = [
  { key: 'shipped', title: 'Shipped', test: /^(merge|merged|deploy|release)\b/i, purpose: 'merge' },
  { key: 'reviews', title: 'Reviews', test: /^(review|re-?check|audit)\b/i, purpose: 'review' },
  { key: 'fixes', title: 'Fixes', test: /^(fix|revise|rebase|patch)\b/i, purpose: 'fix' },
  { key: 'builds', title: 'Builds', test: /^(build|implement|add)\b/i },
  { key: 'qa', title: 'QA', test: /^(qa|test|regression)\b/i, purpose: 'qa' },
];

/** The kind of work: the card's purpose when it is known, else the first word of the task label Sulla gave the agent. */
function kindOf(item: AgentResultItem): string {
  if (item.merges?.length) return 'shipped';
  const byPurpose = KINDS.find(kind => kind.purpose && kind.purpose === item.purpose);
  if (byPurpose) return byPurpose.key;
  return KINDS.find(kind => kind.test.test(item.label.trim()))?.key ?? 'other';
}

/**
 * Results by outcome and kind of work, newest first. A job can post more
 * than one card (a retry, a re-delivery); only its newest counts.
 */
export function groupResults(messages: readonly Message[], activity?: (item: AgentResultItem) => ResultActivity): ResultGroups {
  const pinned: ResultGroups['pinned'] = [];
  const latest = new Map<string, ResultEntry>();
  for (const message of messages) {
    if (message.pinned) pinned.push({ messageId: message.id, text: pinText(message) });
    if (message.kind !== 'proactive') continue;
    for (const item of (message).result?.items ?? []) {
      const key = `${ item.jobId }:${ item.taskIndex }`;
      latest.delete(key);
      latest.set(key, { item, messageId: message.id });
    }
  }
  const entries = [...latest.values()].reverse();
  const current = activity ?? ((item: AgentResultItem) => resultActivity(item, { rows: [], decisions: [], items: entries.map(entry => entry.item) }));
  const needsAction = entries.filter(entry => isFailure(entry.item) && current(entry.item).kind !== 'completed');
  const rest = entries.filter(entry => !needsAction.includes(entry));
  const sections = [...KINDS, { key: 'other', title: 'Other results' }]
    .map(kind => ({ key: kind.key, title: kind.title, items: rest.filter(({ item }) => kindOf(item) === kind.key) }))
    .filter(section => section.items.length);
  return { pinned: pinned.reverse(), needsAction, sections };
}

function isFailure(item: AgentResultItem): boolean { return item.status === 'blocked' || item.status === 'error' || item.tone === 'bad' }

/** Every result, flat, newest first (for search). */
export function allResults(groups: ResultGroups): ResultEntry[] {
  return [...groups.needsAction, ...groups.sections.flatMap(section => section.items)];
}

function pinText(message: Message): string {
  const text = 'text' in message && typeof message.text === 'string' ? message.text : message.kind;
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 90 ? `${ line.slice(0, 89) }…` : line;
}

/** Where a shipped result landed, e.g. "staging" deployed, "production" not. */
export function environmentsOf(item: AgentResultItem): { name: string; state: string }[] {
  return (item.environments ?? []).map(env => ({ name: env.name, state: env.state }));
}

const OPEN_DECISION: readonly DecisionRecord['status'][] = ['pending', 'deferred'];

/** This chat's decisions, open ones first, then newest first. */
export function chatDecisions(records: readonly DecisionRecord[], conversationIds: readonly (string | undefined)[]): DecisionRecord[] {
  const ids = new Set(conversationIds.filter(Boolean));
  return records
    .filter(record => ids.has(record.conversationId))
    .sort((a, b) => Number(OPEN_DECISION.includes(b.status)) - Number(OPEN_DECISION.includes(a.status)) || b.createdAt - a.createdAt);
}

export function isOpenDecision(record: DecisionRecord): boolean { return OPEN_DECISION.includes(record.status) }

/** Full commit hashes swamp a one-line summary; seven characters identify a commit. */
export function shortenHashes(text: string): string { return text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1') }

/** The one line a lane shows under the agent's name: what it is doing right now. */
export function laneStep(row: AgentStateRow, now: number): string { return WorkSteps.plainToolNames(shortenHashes(laneStepRaw(row, now))) }

function laneStepRaw(row: AgentStateRow, now: number): string {
  // A lane tags GitHub waits itself and shows the next check as its time: give just the agent's reason.
  if (row.state === 'parked' && row.waitReason) return row.waitReason.replace(/^\s*waiting\s+(?:for|on)\s+/i, '').replace(/^./, c => c.toUpperCase());
  if (row.state === 'parked') return parkedActivity(row).detail;
  if (row.state === 'blocked') return blockedDetail(row).replace(/^waiting on Sulla: /, 'Asked Sulla: ');
  if (row.state === 'quiet') {
    const said = row.lastCheckinSummary?.trim();
    const words = quietDetail(row, now);
    return said ? `${ words[0].toUpperCase() }${ words.slice(1) } · last: ${ said }` : `${ words[0].toUpperCase() }${ words.slice(1) }`;
  }
  return runningDetail(row, now) || row.lastCheckinSummary || row.stateReason || (row.state === 'queued' ? 'starting' : 'working');
}

export interface ActivityCountSample { at: number; count: number }

/** The activity meter: cumulative action deltas observed in each trailing time slice, oldest first. */
export class ActivityBinProjector {
  values(samples: readonly ActivityCountSample[], now: number, bins = 24, windowMs = 10 * 60_000): number[] {
    const out = new Array<number>(bins).fill(0);
    const size = windowMs / bins;
    for (const sample of samples) {
      const age = now - sample.at;
      if (age < 0 || age >= windowMs) continue;
      out[bins - 1 - Math.floor(age / size)] += sample.count;
    }
    return out;
  }

  height(count: number, max: number): number {
    return count > 0 && max > 0 ? 1 + 11 * count / max : 1;
  }
}

/**
 * Records cumulative action-count deltas at the time each accepted snapshot is
 * observed. Kept only within the 10-minute meter window (lost on reload).
 */
export class ActivityTrail {
  private readonly trail = new Map<string, ActivityCountSample[]>();
  private readonly lastCount = new Map<string, number>();

  record(rows: readonly AgentStateRow[], now: number): void {
    const scopedKeys = new Set(rows.map(row => row.key));
    for (const row of rows) {
      const count = Number.isFinite(row.actionCount) ? row.actionCount ?? 0 : 0;
      const previous = this.lastCount.get(row.key);
      this.lastCount.set(row.key, count);
      const delta = previous !== undefined && count >= previous ? count - previous : 0;
      if (!delta) continue;
      const list = this.trail.get(row.key) ?? [];
      list.push({ at: now, count: delta });
      this.trail.set(row.key, list);
    }

    for (const [key, samples] of this.trail) {
      const retained = scopedKeys.has(key) ? samples.filter(sample => now - sample.at < 10 * 60_000) : [];
      if (retained.length) this.trail.set(key, retained);
      else this.trail.delete(key);
    }
    for (const key of this.lastCount.keys()) if (!scopedKeys.has(key)) this.lastCount.delete(key);
  }

  samples(key: string): readonly ActivityCountSample[] { return this.trail.get(key) ?? [] }

  clear(): void { this.trail.clear(); this.lastCount.clear() }
}

/**
 * Where a PR's checks stand, for the Results tab: what the result recorded
 * (CI line or checks), or an agent still waiting on GitHub for the same PR.
 */
export function ciStateOf(item: AgentResultItem, rows: readonly AgentStateRow[], now = Date.now()): { text: string; tone: 'run' | 'ok' | 'bad' } | null {
  const pr = /#(\d{3,6})\b/.exec(`${ item.change?.pr ?? '' } ${ item.label }`)?.[1];
  const waiting = pr ? rows.find(row => row.state === 'parked' && !!row.waitReason && waitTarget(row) === 'github' && new RegExp(`#${ pr }\\b`).test(`${ row.label } ${ row.waitReason }`)) : undefined;
  if (waiting) {
    const wake = waiting.wakeAt ? Date.parse(waiting.wakeAt) : NaN;
    const mins = Number.isFinite(wake) ? Math.max(0, Math.round((wake - now) / 60_000)) : null;
    return { text: `checks running${ mins !== null ? ` · next look in ${ mins }m` : '' }`, tone: 'run' };
  }
  const checks = item.checks ?? [];
  if (checks.length) {
    const failed = checks.filter(check => !check.passed).length;
    return failed ? { text: `${ failed } of ${ checks.length } checks failed`, tone: 'bad' } : { text: `${ checks.length } checks passed`, tone: 'ok' };
  }
  if (item.change?.ci) return { text: item.change.ci, tone: /fail|red|error/i.test(item.change.ci) ? 'bad' : /pass|green|success/i.test(item.change.ci) ? 'ok' : 'run' };
  return null;
}
