// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ConversationScreenStore, type LiveSnapshot, type PersonView, type ThreadView } from './ConversationScreenStore';

function person(id: string, name: string): PersonView {
  return { id, name, firstName: name.split(' ')[0], initials: '', tone: '', presence: 'online', presenceClass: 'online', status: 'Active now', role: '', agentOnline: false, hasAgent: false, agentName: '' };
}
function thread(id: string, kind: ThreadView['kind'], title: string, latest: string, unread = 0): ThreadView {
  return { id, kind, title, participantIds: ['u-me', 'u-x'], latest, time: '', unread, withId: 'u-x' };
}

function storeWith(threads: ThreadView[], memberCount = 3): ConversationScreenStore {
  const snapshot: LiveSnapshot = {
    orgId: 'o1', orgName: 'Acme', orgs: [{ id: 'o1', name: 'Acme', initials: 'A', memberCount, gradient: '' }],
    me: person('u-me', 'Ada Lovelace'), people: [person('u-two', 'Grace Hopper'), person('u-three', 'Alan Turing')],
    threads, requests: [], bodies: {}, relay: 'connected', online: true,
  };
  const store = new ConversationScreenStore();
  store.setLive(snapshot);
  return store;
}

const threads = [
  thread('dm', 'direct', 'Grace Hopper', 'You: compiler notes', 2),
  thread('grp', 'group', 'Launch', 'Alan: ship it'),
  thread('a2a', 'agent_thread', 'Your agent and Grace\'s agent', 'Agenda shared', 1),
];

describe('ConversationScreenStore list filters', () => {
  it('splits the Conversations list into people threads, agent threads and unread threads', () => {
    // risk: data accuracy; a filter that leaks agent threads into People (or hides unread ones) misreports the inbox
    const store = storeWith(threads);

    store.setSegment('people');
    expect(store.visibleThreads().map(row => row.id)).toEqual(['dm', 'grp']);
    store.setSegment('agents');
    expect(store.visibleThreads().map(row => row.id)).toEqual(['a2a']);
    store.setSegment('unread');
    expect(store.visibleThreads().map(row => row.id)).toEqual(['dm', 'a2a']);

    store.openThread('dm');
    expect(store.visibleThreads().map(row => row.id)).toEqual(['a2a']);
  });

  it('searches thread titles and previews, and people by name, case-insensitively', () => {
    // risk: data accuracy; search must find a conversation by what was said, not only by who said it
    const store = storeWith(threads);

    store.setQuery('  SHIP ');
    expect(store.visibleThreads().map(row => row.id)).toEqual(['grp']);
    store.setQuery('grace');
    expect(store.visibleThreads().map(row => row.id)).toEqual(['dm', 'a2a']);
    expect(store.visiblePeople().map(row => row.id)).toEqual(['u-two']);
    expect(store.visibleMe()).toBeNull();
    store.setQuery('');
    expect(store.visiblePeople()).toHaveLength(2);
    expect(store.visibleMe()?.id).toBe('u-me');
  });

  it('applies the segment only on the Conversations tab', () => {
    // risk: data accuracy; a stale Unread segment must not empty the Agent threads tab
    const store = storeWith(threads);
    store.setSegment('unread');
    store.setListTab('agents');

    expect(store.visibleThreads().map(row => row.id)).toEqual(['a2a']);
  });
});

describe('ConversationScreenStore nav counts', () => {
  it('counts unread messages outside the open thread, org members and agent threads', () => {
    // risk: data accuracy; badges must come from real data, and the open thread is already read
    const store = storeWith(threads, 5);
    expect(store.navCounts()).toEqual({ threads: 3, people: 5, agents: 1 });

    store.openThread('dm');
    expect(store.navCounts().threads).toBe(1);
  });

  it('hides a badge (null) when the count is zero', () => {
    // risk: data accuracy; a "0" badge or a badge with no data behind it would be invented
    const store = storeWith([thread('dm', 'direct', 'Grace Hopper', 'hi')], 0);

    expect(store.navCounts()).toEqual({ threads: null, people: null, agents: null });
  });
});
