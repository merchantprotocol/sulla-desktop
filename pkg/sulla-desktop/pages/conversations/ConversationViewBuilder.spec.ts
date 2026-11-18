// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import type { ConversationMessageData } from './ConversationProjection';
import { ConversationViewBuilder, type DirectoryPerson } from './ConversationViewBuilder';

const people: DirectoryPerson[] = [
  { userId: 'u-me', displayName: 'Ada Lovelace', presence: 'online', agentHostOnline: true, role: 'owner' },
  { userId: 'u-two', displayName: 'Grace Hopper', presence: 'busy', agentHostOnline: false },
  { userId: 'u-three', displayName: 'Alan Turing' },
];
const NOW = new Date(2026, 10, 18, 12, 0, 0);
const builder = new ConversationViewBuilder(people, 'u-me', () => NOW);

function message(overrides: Partial<ConversationMessageData>): ConversationMessageData {
  return { messageId: 'm1', conversationId: 'c1', orgId: 'o1', kind: 'human', from: { userId: 'u-two' }, to: [{ userId: 'u-me' }], body: { text: 'hello' }, createdAt: new Date(2026, 10, 18, 9, 30).toISOString(), ...overrides };
}

describe('ConversationViewBuilder', () => {
  it('labels another member’s agent as theirs and your own agent as yours', () => {
    // risk: data accuracy; an agent message attributed to the wrong human misleads who acted for whom
    const theirs = builder.message(message({ from: { userId: 'u-two', agentId: 'a2' } }));
    const mine = builder.message(message({ from: { userId: 'u-me', agentId: 'a1' }, to: [{ userId: 'u-two' }] }));

    expect(theirs).toMatchObject({ side: 'agent', theirs: true, name: 'Grace\'s agent', actsFor: 'Agent · acts for Grace Hopper' });
    expect(mine).toMatchObject({ side: 'agent', theirs: false, name: 'Your agent', actsFor: 'Agent · acts for you' });
  });

  it('renders a halt control message as a red system pill naming who stopped it', () => {
    // risk: data accuracy; a stop must read as a stop, not as a chat message saying "halt"
    const view = builder.message(message({ kind: 'control', control: { action: 'halt' }, body: { text: 'halt' } }));

    expect(view.side).toBe('system');
    expect(view.sysTone).toBe('bad');
    expect(view.text.startsWith('Grace Hopper stopped this thread')).toBe(true);
  });

  it('groups messages under TODAY, YESTERDAY, weekday and dated dividers', () => {
    // risk: data accuracy; a wrong day divider misdates the conversation
    expect(builder.dayLabel(new Date(2026, 10, 18, 0, 5).toISOString())).toBe('TODAY');
    expect(builder.dayLabel(new Date(2026, 10, 17, 23, 55).toISOString())).toBe('YESTERDAY');
    expect(builder.dayLabel(new Date(2026, 10, 15, 10, 0).toISOString())).toBe('SUNDAY');
    expect(builder.dayLabel(new Date(2026, 10, 3, 10, 0).toISOString())).toBe('NOV 3');
    expect(builder.dayLabel(new Date(2025, 10, 3, 10, 0).toISOString())).toBe('NOV 3, 2025');
    expect(builder.dayLabel('not a date')).toBe('');
  });

  it('maps presence to the status line and dot, with Offline when the directory sends none', () => {
    // risk: data accuracy; showing someone as available when they are not
    expect(builder.person(people[0])).toMatchObject({ presenceClass: 'online', status: 'Available', role: 'Owner', tone: 'a', agentOnline: true });
    expect(builder.person(people[1])).toMatchObject({ presenceClass: 'busy', status: 'Busy', role: '', agentOnline: false });
    expect(builder.person(people[2])).toMatchObject({ presenceClass: 'offline', status: 'Offline' });
  });

  it('prefixes your own previews with You and names the sender in groups', () => {
    // risk: data accuracy; the list preview must say who wrote the last message
    expect(builder.preview(message({ from: { userId: 'u-me' } }), 'direct')).toBe('You: hello');
    expect(builder.preview(message({}), 'group')).toBe('Grace: hello');
    expect(builder.preview(message({}), 'direct')).toBe('hello');
  });

  it('titles an agent thread after the other member’s agent', () => {
    // risk: data accuracy; the thread list must show whose agent you are talking to
    const view = builder.thread({ id: 'c1', kind: 'agent_thread', title: 'Grace Hopper', participantIds: ['u-me', 'u-two'], messages: [message({ from: { userId: 'u-two', agentId: 'a2' } })], latest: 'hello', unread: 2 });

    expect(view).toMatchObject({ title: 'Your agent and Grace\'s agent', withId: 'u-two', unread: 2, latest: 'hello' });
  });
});
