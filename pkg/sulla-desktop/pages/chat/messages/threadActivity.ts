// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';

import type { Message } from '../models/Message';

/**
 * What a chat thread is doing right now, so a thread never looks the same
 * whether Sulla is busy, waiting, blocked on the user or idle.
 * Priority: needs you > stalled > working > waiting > idle.
 */
export type ThreadActivityState = 'you' | 'stalled' | 'working' | 'waiting' | 'idle';

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
  you: 'Needs you', stalled: 'No progress', working: 'Working', waiting: 'Waiting', idle: 'Idle',
};

function plural(n: number, word: string): string {
  return `${ n } ${ word }${ n === 1 ? '' : 's' }`;
}

function agentItem(row: AgentStateRow): ThreadActivityItem | null {
  const at = Date.parse(row.lastActivityAt) || undefined;
  const ref = { kind: 'agent' as const, key: row.key };
  const said = row.lastCheckinSummary || row.stateReason || '';
  switch (row.state) {
  case 'working': case 'queued':
    return { state: 'working', title: row.label, detail: said || (row.state === 'queued' ? 'starting' : 'working'), at, ref };
  case 'parked':
    return { state: 'waiting', title: row.label, detail: `waiting on ${ plural(row.waitingOnChildren, 'agent') }`, at, ref };
  case 'quiet':
    return { state: 'stalled', title: row.label, detail: said || 'no check-in lately', at, ref };
  case 'blocked':
    return { state: 'you', title: row.label, detail: said || 'reported a blocker', at, ref };
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
    parts = [`${ plural(count('stalled'), 'agent') } silent`, 'it may have stopped'];
  } else if (input.running || has('working')) {
    state = 'working';
    parts = [count('working') ? `${ plural(count('working'), 'agent') } running` : 'Sulla is replying'];
    const lead = items.find(item => item.state === 'working');
    if (lead) parts.push(lead.title);
  } else if (has('waiting')) {
    state = 'waiting';
    const parked = items.filter(item => item.state === 'waiting' && item.ref.kind === 'agent');
    parts = parked.length ? [`${ plural(parked.length, 'agent') } waiting on others`] : [];
    if (input.heartbeatMinutes) parts.push(`heartbeat every ${ input.heartbeatMinutes } min`);
  } else {
    state = 'idle';
    parts = ['nothing running or scheduled'];
  }

  return { state, lead: LEAD[state], parts, items, lastActivityAt };
}

/** "12s", "4m", "2h": compact age for the status line. */
export function activityAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${ seconds }s`;
  if (seconds < 3600) return `${ Math.floor(seconds / 60) }m`;
  return `${ Math.floor(seconds / 3600) }h`;
}
