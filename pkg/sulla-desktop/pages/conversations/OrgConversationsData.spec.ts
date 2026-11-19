// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import type { ConversationMessageData } from './ConversationProjection';
import { ConversationDataState, OrgConversationsLoader, type OrgConversationsGateway } from './OrgConversationsData';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function message(id: string, org: string, text = 'hello'): ConversationMessageData {
  return {
    messageId: id, conversationId: 'c-1', orgId: org, kind: 'human',
    from: { userId: 'u-me' }, to: [{ userId: 'u-ada' }], body: { text }, createdAt: '2026-11-18T10:00:00.000Z',
  };
}

/** A gateway where every read answers with a healthy reply unless the test overrides it. */
function gateway(overrides: Partial<OrgConversationsGateway> = {}): OrgConversationsGateway {
  return {
    directory: async () => ({ directory: { people: [{ id: 'u-ada', name: 'Ada Lovelace', agent_host_active: 1 }] } }),
    inbox: async () => ({ messages: [message('m-1', ORG_A)] }),
    participant: async () => ({ userId: 'u-me' }),
    contactRequests: async () => ({ requests: [] }),
    memberships: async () => ({ memberships: [{ userId: 'u-ada', role: 'admin' }] }),
    invitations: async () => ({ invitations: [] }),
    ...overrides,
  };
}

describe('OrgConversationsLoader', () => {
  it('keeps the inbox and the member list when one other read fails', async () => {
    // risk: data accuracy; before the fix Promise.all rejected on one failed read and blanked the whole screen
    const load = await new OrgConversationsLoader(gateway({
      directory: async () => { throw new Error("Error invoking remote method 'org-conversations:directory': Error: Broker request timed out"); },
    })).load(ORG_A);

    expect(load.people).toBeUndefined();
    expect(load.messages?.map(entry => entry.messageId)).toEqual(['m-1']);
    expect(load.userId).toBe('u-me');
    expect(load.problems).toEqual(['Members could not be loaded (Broker request timed out).']);
  });

  it('reports a malformed reply as a problem instead of an empty list', async () => {
    // risk: data accuracy; an unexpected reply shape must not look like "no people" or "no conversations"
    const load = await new OrgConversationsLoader(gateway({
      directory: async () => ({ membership: { orgId: ORG_A } }),
      inbox: async () => null,
    })).load(ORG_A);

    expect(load.people).toBeUndefined();
    expect(load.messages).toBeUndefined();
    expect(load.problems).toEqual(['Members response was malformed.', 'Conversations response was malformed.']);
  });

  it('shows members without roles when only the memberships read fails, and raises no problem', async () => {
    // risk: permissions; a failed role read must hide the role pill, not show a wrong one, and it is best-effort
    const load = await new OrgConversationsLoader(gateway({
      memberships: async () => { throw new Error('forbidden'); },
    })).load(ORG_A);

    expect(load.people?.map(person => ({ id: person.userId, role: person.role }))).toEqual([{ id: 'u-ada', role: undefined }]);
    expect(load.problems).toEqual([]);
  });

  it('turns a missing member id into a problem and never sends an empty id on', async () => {
    // risk: data accuracy; an empty sender id would author messages as nobody
    const load = await new OrgConversationsLoader(gateway({ participant: async () => ({ userId: '' }) })).load(ORG_A);

    expect(load.userId).toBeUndefined();
    expect(load.problems).toEqual(['Your member id could not be read.']);
  });
});

describe('ConversationDataState', () => {
  it('ignores a load that a newer load has superseded', () => {
    // risk: data accuracy; an old org's reply landing late must not overwrite the org the person picked
    const state = new ConversationDataState();
    const first = state.begin(ORG_A);
    const second = state.begin(ORG_B);

    expect(state.apply(first, ORG_A, { messages: [message('m-old', ORG_A)], problems: [] })).toBe(false);
    expect(state.apply(second, ORG_B, { messages: [message('m-b', ORG_B)], problems: [] })).toBe(true);
    expect(state.data.org).toBe(ORG_B);
    expect(state.data.messages.map(entry => entry.messageId)).toEqual(['m-b']);
  });

  it('keeps the last good data for the same org when a reload fails', () => {
    // risk: data accuracy; a Cloud or vault failure must not blank the conversations the person was reading
    const state = new ConversationDataState();
    state.apply(state.begin(ORG_A), ORG_A, { messages: [message('m-1', ORG_A)], people: [], problems: [] });

    state.apply(state.begin(ORG_A), ORG_A, { problems: ['Conversations could not be loaded (Broker request timed out).'] });

    expect(state.data.messages.map(entry => entry.messageId)).toEqual(['m-1']);
    expect(state.data.problems).toEqual(['Conversations could not be loaded (Broker request timed out).']);
  });

  it('starts an org switch empty so the previous org never shows under the new one', () => {
    // risk: permissions and tenant isolation; a failed load for the new org must not show the old org's people or threads
    const state = new ConversationDataState();
    state.apply(state.begin(ORG_A), ORG_A, { messages: [message('m-1', ORG_A)], people: [{ userId: 'u-ada', displayName: 'Ada', agentHostOnline: false }], problems: [] });

    state.apply(state.begin(ORG_B), ORG_B, { problems: ['Members could not be loaded (forbidden).'] });

    expect(state.data.org).toBe(ORG_B);
    expect(state.data.messages).toEqual([]);
    expect(state.data.people).toEqual([]);
  });

  it('keeps a message the person sent through a failing reload until the inbox returns it', () => {
    // risk: data accuracy; before the fix refresh() cleared localSent first, so a sent message vanished on a failed reload
    const state = new ConversationDataState();
    state.apply(state.begin(ORG_A), ORG_A, { messages: [], problems: [] });
    state.addSent(message('m-sent', ORG_A, 'sent just now'));

    state.apply(state.begin(ORG_A), ORG_A, { problems: ['Conversations could not be loaded (timeout).'] });
    expect(state.data.localSent.map(entry => entry.messageId)).toEqual(['m-sent']);

    state.apply(state.begin(ORG_A), ORG_A, { messages: [message('m-sent', ORG_A, 'sent just now')], problems: [] });
    expect(state.data.localSent).toEqual([]);
  });

  it('does not keep a sent message for an org the person has already left', () => {
    // risk: tenant isolation; a send that finishes after an org switch must not show in the other org
    const state = new ConversationDataState();
    state.apply(state.begin(ORG_B), ORG_B, { messages: [], problems: [] });

    state.addSent(message('m-a', ORG_A));

    expect(state.data.localSent).toEqual([]);
  });
});
