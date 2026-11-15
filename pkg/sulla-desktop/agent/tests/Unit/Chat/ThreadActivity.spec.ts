// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { activityAge, deriveThreadActivity, parkedActivity } from '@pkg/pages/chat/messages/threadActivity';

const row = (state: string, extra: Record<string, unknown> = {}) => ({
  key:                `job:${ state }`,
  label:              `${ state } agent`,
  state,
  waitingOnChildren:  0,
  lastActivityAt:     '2026-11-14T20:00:00Z',
  lastCheckinSummary: null,
  stateReason:        null,
  ...extra,
}) as any;
const base = { running: false, messages: [], agents: [], heartbeatMinutes: null };

describe('a chat thread always says what it is doing', () => {
  // risk: the main thread looked identical whether Sulla was busy, waiting or idle
  it('is idle only when nothing runs, waits or is scheduled', () => {
    expect(deriveThreadActivity(base).state).toBe('idle');
  });

  it('shows working while a turn runs, even before any agent exists', () => {
    expect(deriveThreadActivity({ ...base, running: true })).toMatchObject({ state: 'working', parts: ['Sulla is replying'] });
  });

  it('shows working for live background agents after the turn ended', () => {
    const a = deriveThreadActivity({ ...base, agents: [row('working'), row('done')] });
    expect(a.state).toBe('working');
    expect(a.parts[0]).toBe('1 agent running');
  });

  it('counts parked agents and a heartbeat as waiting, not idle', () => {
    expect(deriveThreadActivity({ ...base, agents: [row('parked', { waitingOnChildren: 2 })] }).state).toBe('waiting');
    expect(deriveThreadActivity({ ...base, heartbeatMinutes: 20 })).toMatchObject({ state: 'waiting', parts: ['heartbeat every 20 min'] });
  });

  // risk: a worker re-parked after an empty turn waits on no one, yet the thread said "waiting on others"
  it('treats a parked agent with no children and no scheduled wake-up as idle', () => {
    const a = deriveThreadActivity({ ...base, agents: [row('parked')] });
    expect(a).toMatchObject({ state: 'idle', parts: ['1 agent idle, waiting for a message'] });
    expect(a.items).toEqual([]);
    expect(parkedActivity(row('parked')).detail).toBe('idle, waiting for a message');
  });

  it('still waits on a parked agent with live children or a scheduled wake-up', () => {
    expect(parkedActivity(row('parked', { waitingOnChildren: 2 }))).toEqual({ state: 'waiting', detail: 'waiting on 2 agents' });
    const timer = row('parked', { stateReason: 'scheduled wake-up' });
    expect(parkedActivity(timer)).toEqual({ state: 'waiting', detail: 'waiting on a scheduled wake-up' });
    expect(deriveThreadActivity({ ...base, agents: [timer, row('parked', { key: 'job:idle' })] })).toMatchObject({ state: 'waiting', parts: ['1 agent waiting on others'] });
  });

  // risk: a sub-agent's blocker is addressed to Sulla, yet the bar told the user "Needs you"
  // and showed the agent's progress summary instead of the blocker
  it('shows a blocked sub-agent as waiting on Sulla, with the blocker first', () => {
    const blocked = row('blocked', { label: 'Research · Astra tax-sync', lastCheckinSummary: 'Ten vendors researched.', stateReason: 'Need the Astra account login' });
    const a = deriveThreadActivity({ ...base, agents: [blocked] });

    expect(a.state).toBe('waiting');
    expect(a.items[0]).toMatchObject({ state: 'waiting', detail: 'waiting on Sulla: Need the Astra account login' });
  });

  it('still says Needs you for a pending question even when a sub-agent is blocked', () => {
    const question = { id: 'q1', kind: 'tool_question', status: 'pending', createdAt: 1, questions: [{ header: 'Scope', question: 'Ship phase 1?' }] } as any;
    expect(deriveThreadActivity({ ...base, agents: [row('blocked', { stateReason: 'x' })], messages: [question] }).state).toBe('you');
  });

  // risk: a pending decision hid behind "working" while the user was the blocker
  it('puts an open question or approval ahead of everything else', () => {
    const question = { id: 'q1', kind: 'tool_question', status: 'pending', createdAt: 1, questions: [{ header: 'Merge', question: 'Merge now?' }] } as any;
    const a = deriveThreadActivity({ ...base, running: true, agents: [row('working')], messages: [question] });
    expect(a.state).toBe('you');
    expect(a.parts[0]).toBe('Merge: Merge now?');
  });

  it('ignores answered questions and decided approvals', () => {
    const done = [{ id: 'q', kind: 'tool_question', status: 'answered', questions: [] }, { id: 'a', kind: 'tool_approval', decision: 'approved' }] as any;
    expect(deriveThreadActivity({ ...base, messages: done }).state).toBe('idle');
  });

  it('flags a silent agent as stalled ahead of other work', () => {
    const a = deriveThreadActivity({ ...base, running: true, agents: [row('quiet'), row('working')] });
    expect(a.state).toBe('stalled');
  });

  // risk: one silent agent turned the whole line into "it may have stopped" while others worked
  it('says what else is still working when one agent goes silent', () => {
    const a = deriveThreadActivity({ ...base, agents: [row('quiet'), row('working', { key: 'job:w1' }), row('working', { key: 'job:w2' })] });
    expect(a).toMatchObject({ state: 'stalled', parts: ['1 agent silent', '2 agents still working'] });
  });

  // risk: an agent in one long command read as idle filler text instead of what it is doing
  it('shows a long-running command instead of the last check-in', () => {
    const since = new Date(Date.now() - 7 * 60_000).toISOString();
    const a = deriveThreadActivity({ ...base, agents: [row('working', { lastCheckinSummary: 'QBO sandbox seeded', toolInFlight: { name: 'a command', since } })] });
    expect(a.items[0].detail).toBe('running a command for 7m');
  });

  it('formats ages compactly', () => {
    expect([activityAge(12_000), activityAge(240_000), activityAge(7_200_000)]).toEqual(['12s', '4m', '2h']);
  });
});
