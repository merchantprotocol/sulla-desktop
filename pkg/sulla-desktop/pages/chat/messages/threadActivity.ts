// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

import type { Message } from '../models/Message';

/**
 * What a chat thread is doing right now, so a thread never looks the same
 * whether Sulla is busy, waiting, blocked on the user or idle.
 * Priority: needs you > stalled > working > quiet > waiting > idle. Quiet is an
 * agent with no output lately whose container is still running; stalled is one
 * that stopped responding (or that we cannot see running).
 */
export type ThreadActivityState = 'you' | 'stalled' | 'working' | 'quiet' | 'waiting' | 'idle';

export interface ThreadActivityItem {
  state:  Exclude<ThreadActivityState, 'idle'>;
  title:  string;
  detail: string;
  /** Epoch ms of the item's latest activity, when known. */
  at?:    number;
  /** Agent row key or message id, so the UI can open the right thing. */
  ref:    { kind: 'agent'; key: string } | { kind: 'message'; id: string } | { kind: 'heartbeat' };
}

export interface ThreadActivity {
  state:           ThreadActivityState;
  lead:            string;
  parts:           string[];
  items:           ThreadActivityItem[];
  /** Latest activity across the thread's running work, for the "last activity" age. */
  lastActivityAt?: number;
}

export interface ThreadActivityInput {
  running:          boolean;
  messages:         readonly Message[];
  agents:           readonly AgentStateRow[];
  heartbeatMinutes: number | null;
}

const LEAD: Record<ThreadActivityState, string> = {
  you: 'Needs you', stalled: 'No progress', working: 'Working', quiet: 'Quiet', waiting: 'Waiting', idle: 'Idle',
};

function plural(n: number, word: string): string {
  return `${ n } ${ word }${ n === 1 ? '' : 's' }`;
}

/**
 * A parked agent is only waiting while it has live children or a scheduled
 * wake-up. One re-parked after a turn that returned nothing waits on no one:
 * it sits idle until it is messaged or stopped.
 */
export function parkedActivity(row: AgentStateRow): { state: 'waiting' | 'idle'; detail: string } {
  if (row.waitingOnChildren > 0) return { state: 'waiting', detail: `waiting on ${ plural(row.waitingOnChildren, 'agent') }` };
  if (row.waitReason || row.wakeAt) return { state: 'waiting', detail: waitDetail(row) };
  if (row.stateReason) return { state: 'waiting', detail: `waiting on a ${ row.stateReason }` };
  return { state: 'idle', detail: 'idle, waiting for a message' };
}

/** Waits on something outside Sulla that GitHub runs: CI, tests, checks, builds, reviews on a PR. */
const GITHUB_WAIT = /\b(ci|checks?|tests?|shards?|workflows?|build(?: job)?|github|pull request|pr\s*#?\d+|full-(?:pr-)?tests)\b/i;

/** What a timer-parked agent waits on: GitHub's runs, or something else it named. */
export function waitTarget(row: AgentStateRow): 'github' | 'other' | null {
  if (row.state !== 'parked' || row.waitingOnChildren > 0 || !(row.waitReason || row.wakeAt)) return null;
  return row.waitReason && GITHUB_WAIT.test(row.waitReason) ? 'github' : 'other';
}

/** "Waiting on GitHub: CI full-tests running on 391bf1f · checks again 12:12" */
export function waitDetail(row: AgentStateRow): string {
  const reason = (row.waitReason ?? '').replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1').trim();
  const wake = row.wakeAt ? ` · checks again ${ clockOf(row.wakeAt) }` : '';
  if (!reason) return `waiting${ wake ? ` until it checks again${ wake.replace(' · checks again', '') }` : '' }`;
  return `${ waitTarget(row) === 'github' ? 'waiting on GitHub' : 'waiting' }: ${ reason }${ wake }`;
}

function clockOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Every agent listed here was launched from this thread, so it raises its
 * blocker to Sulla, not to the user. Only pending questions and approvals
 * need the user. The blocker text leads: it is what explains the state.
 */
/** "running a command for 7m" once a single call has run a minute; it explains a long silence. */
export function runningDetail(row: AgentStateRow, now: number): string | undefined {
  const since = row.toolInFlight ? Date.parse(row.toolInFlight.since) : NaN;
  if (!Number.isFinite(since) || now - since < 60_000) return undefined;
  return `running ${ row.toolInFlight!.name } for ${ activityAge(now - since) }`;
}

export function blockedDetail(row: AgentStateRow): string {
  return `waiting on Sulla: ${ row.stateReason || row.lastCheckinSummary || 'reported a blocker' }`;
}

function agentItem(row: AgentStateRow): ThreadActivityItem | null {
  const at = Date.parse(row.lastActivityAt) || undefined;
  const ref = { kind: 'agent' as const, key: row.key };
  const said = row.lastCheckinSummary || row.stateReason || '';
  switch (row.state) {
  case 'working': case 'queued':
    return { state: 'working', title: row.label, detail: runningDetail(row, Date.now()) || said || (row.state === 'queued' ? 'starting' : 'working'), at, ref };
  case 'parked': {
    const parked = parkedActivity(row);
    return parked.state === 'waiting' ? { state: 'waiting', title: row.label, detail: parked.detail, at, ref } : null;
  }
  case 'quiet':
    return { state: row.runtimeAlive ? 'quiet' : 'stalled', title: row.label, detail: quietDetail(row, Date.now()), at, ref };
  case 'blocked':
    return { state: 'waiting', title: row.label, detail: blockedDetail(row), at, ref };
  default:
    return null;
  }
}

function humanItems(messages: readonly Message[]): ThreadActivityItem[] {
  const items: ThreadActivityItem[] = [];
  for (const msg of messages) {
    if (msg.kind === 'tool_question' && msg.status === 'pending') {
      const first = msg.questions[0];
      items.push({ state: 'you', title: first?.header || 'Question', detail: msg.questions.length > 1 ? `${ msg.questions.length } questions to answer` : first?.question || 'waiting for your answer', at: msg.createdAt, ref: { kind: 'message', id: msg.id } });
    } else if (msg.kind === 'tool_approval' && msg.decision === 'pending') {
      items.push({ state: 'you', title: 'Approval', detail: msg.reason || msg.command, at: msg.createdAt, ref: { kind: 'message', id: msg.id } });
    }
  }
  return items;
}

export function deriveThreadActivity(input: ThreadActivityInput): ThreadActivity {
  const items = [
    ...humanItems(input.messages),
    ...input.agents.map(agentItem).filter((item): item is ThreadActivityItem => item !== null),
  ];
  const has = (state: ThreadActivityState) => items.some(item => item.state === state);
  const count = (state: ThreadActivityState) => items.filter(item => item.state === state).length;
  if (input.heartbeatMinutes) {
    items.push({ state: 'waiting', title: 'Heartbeat', detail: `every ${ input.heartbeatMinutes } min`, ref: { kind: 'heartbeat' } });
  }
  const activity = items.map(item => item.at ?? 0).filter(Boolean);
  const lastActivityAt = activity.length ? Math.max(...activity) : undefined;

  let state: ThreadActivityState;
  let parts: string[];
  if (has('you')) {
    state = 'you';
    parts = items.filter(item => item.state === 'you').map(item => `${ item.title }: ${ item.detail }`).slice(0, 2);
  } else if (has('stalled')) {
    state = 'stalled';
    // One silent agent must not hide the rest: say what else is still moving.
    const working = count('working');
    parts = [`${ plural(count('stalled'), 'agent') } stopped responding`, ...(working ? [`${ plural(working, 'agent') } still working`] : [])];
  } else if (input.running || has('working')) {
    state = 'working';
    parts = [count('working') ? `${ plural(count('working'), 'agent') } running` : 'Sulla is replying'];
    const lead = items.find(item => item.state === 'working');
    if (lead) parts.push(lead.title);
    if (has('quiet')) parts.push(`${ count('quiet') } quiet`);
  } else if (has('quiet')) {
    state = 'quiet';
    parts = [`${ plural(count('quiet'), 'agent') } quiet`, 'still running'];
  } else if (has('waiting')) {
    state = 'waiting';
    const parked = input.agents.filter(row => row.state === 'parked' && parkedActivity(row).state === 'waiting');
    const onGitHub = parked.filter(row => waitTarget(row) === 'github').length;
    const others = parked.length - onGitHub;
    parts = [
      ...(onGitHub ? [`${ plural(onGitHub, 'agent') } waiting on GitHub checks`] : []),
      ...(others ? [`${ plural(others, 'agent') } waiting on ${ onGitHub ? 'other work' : 'others' }`] : []),
    ];
    // When the next of them looks again, so a quiet thread reads as scheduled, not stuck.
    const next = parked.map(row => (row.wakeAt ? Date.parse(row.wakeAt) : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (next) parts.push(`next check ${ clockOf(new Date(next).toISOString()) }`);
    if (input.heartbeatMinutes) parts.push(`heartbeat every ${ input.heartbeatMinutes } min`);
  } else {
    state = 'idle';
    const idleAgents = input.agents.filter(row => row.state === 'parked' && parkedActivity(row).state === 'idle').length;
    parts = [idleAgents ? `${ plural(idleAgents, 'agent') } idle, waiting for a message` : 'nothing running or scheduled'];
  }

  return { state, lead: LEAD[state], parts, items, lastActivityAt };
}

/**
 * A quiet agent in words: "quiet 6m · still running" when its container is
 * still attached, "no output for 12m · container gone" when it is not.
 */
export function quietDetail(row: AgentStateRow, now: number): string {
  const age = activityAge(now - (Date.parse(row.lastActivityAt) || now));
  if (row.runtimeAlive) return `quiet ${ age } · still running`;
  return `no output for ${ age }${ row.runtimeAlive === false ? ' · container gone' : '' }`;
}

/** "12s", "4m", "2h": compact age for the status line. */
export function activityAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${ seconds }s`;
  if (seconds < 3600) return `${ Math.floor(seconds / 60) }m`;
  return `${ Math.floor(seconds / 3600) }h`;
}
