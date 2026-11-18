// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { ConversationViewBuilder, type DirectoryPerson } from './ConversationViewBuilder';

const NOW = new Date(2026, 10, 18, 12, 0, 0);

describe('ConversationViewBuilder People rows', () => {
  it('never leaves the status line empty: presence, then Available for you, then Agent online or Offline', () => {
    // risk: data accuracy; an empty status line shrinks the People row below the mockup
    const people: DirectoryPerson[] = [
      { userId: 'u-me', displayName: 'Ada Lovelace' },
      { userId: 'u-agent', displayName: 'Grace Hopper', agentHostOnline: true },
      { userId: 'u-quiet', displayName: 'Alan Turing', agentHostOnline: false },
      { userId: 'u-busy', displayName: 'Sam Okafor', presence: 'busy', agentHostOnline: false },
    ];
    const builder = new ConversationViewBuilder(people, 'u-me', () => NOW);
    expect(builder.person(people[0]).status).toBe('Available');
    expect(builder.person(people[1]).status).toBe('Agent online');
    expect(builder.person(people[2]).status).toBe('Offline');
    expect(builder.person(people[3]).status).toBe('Busy');
    for (const person of people) expect(builder.person(person).status).not.toBe('');
  });

  it('names each person’s agent from that person’s own first name, never one shared name', () => {
    // risk: data accuracy; reusing one first name for every agent line misattributes agents
    const people: DirectoryPerson[] = [
      { userId: 'u-me', displayName: 'Ada Lovelace' },
      { userId: 'u-1', displayName: 'Grace Hopper', agentHostOnline: true },
      { userId: 'u-2', displayName: 'Alan Turing', agentHostOnline: false },
    ];
    const builder = new ConversationViewBuilder(people, 'u-me', () => NOW);
    expect(builder.person(people[0]).agentName).toBe('Your agent');
    expect(builder.person(people[1]).agentName).toBe('Grace\'s agent');
    expect(builder.person(people[2]).agentName).toBe('Alan\'s agent');
  });

  it('shows an agent line only for members the directory reports an agent for', () => {
    // risk: data accuracy; a person with no agent must not get an agent line
    const people: DirectoryPerson[] = [
      { userId: 'u-1', displayName: 'Grace Hopper' },
      { userId: 'u-2', displayName: 'Alan Turing', agentHostOnline: false },
      { userId: 'u-3', displayName: 'Sam Okafor', agentName: 'Sam\'s desk agent' },
    ];
    const builder = new ConversationViewBuilder(people, 'u-me', () => NOW);
    expect(builder.person(people[0]).hasAgent).toBe(false);
    expect(builder.person(people[1]).hasAgent).toBe(true);
    expect(builder.person(people[2]).hasAgent).toBe(true);
    expect(builder.person(people[2]).agentName).toBe('Sam\'s desk agent');
  });

  it('builds an Invited row with initials from the email local part and no other identity', () => {
    // risk: privacy; an invite row carries the email only, never a token or link
    const builder = new ConversationViewBuilder([], 'u-me', () => NOW);
    const invite = builder.invitation({ id: 'inv-1', email: 'devin.park@example.com' });
    expect(invite).toEqual({ id: 'inv-1', email: 'devin.park@example.com', initials: 'DP' });
    expect(Object.keys(invite).sort()).toEqual(['email', 'id', 'initials']);
  });
});
