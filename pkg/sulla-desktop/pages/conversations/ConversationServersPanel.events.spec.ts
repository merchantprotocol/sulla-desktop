// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }));

import ConversationServersPanel from './components/ConversationServersPanel.vue';

const publicServer = { id: 'public', name: 'Public', visibility: 'public', ownerUserId: 'owner', notificationDefault: 'all' };
const orgServer = { id: 'org', name: 'Organization', visibility: 'organization', orgId: 'org-id', ownerUserId: 'owner', notificationDefault: 'all' };
const channels = {
  public: [{ id: 'public-channel', serverId: 'public', name: 'general', kind: 'text', private: false, notificationLevel: 'all' }],
  org: [{ id: 'org-channel', serverId: 'org', name: 'team', kind: 'text', private: false, notificationLevel: 'all' }],
};

function invokeResult(channel: string, arg?: unknown): unknown {
  if (channel === 'org-conversations:organizations') return [];
  if (channel === 'conversation-servers:list') return [publicServer, orgServer];
  if (channel === 'conversation-servers:channels') return (arg as string) === 'org' ? channels.org : channels.public;
  if (channel === 'conversation-servers:members') return [];
  if (channel === 'conversation-servers:channel-preference') return { preference: null, channelOverride: null };
  if (channel === 'conversation-servers:messages') return { messages: [] };
  if (channel === 'conversation-servers:unread') return { channels: [] };
  return undefined;
}

async function selectServer(wrapper: ReturnType<typeof mount>, server: string): Promise<void> {
  await wrapper.get(`[aria-label="${server} server"]`).trigger('click');
  await vi.waitFor(() => expect(wrapper.find('textarea').exists()).toBe(true));
  await flushPromises();
}

describe('ConversationServersPanel composer events', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((channel: string, arg?: unknown) => Promise.resolve(invokeResult(channel, arg)));
  });

  it('sends Enter to the composer source channel even after selection changes', async () => {
    // risk: privacy; an async channel switch must not redirect a message to a different destination
    let finishSend!: () => void;
    invoke.mockImplementation((channel: string, arg?: unknown) => channel === 'conversation-servers:send-message'
      ? new Promise(resolve => { finishSend = () => resolve(undefined); })
      : Promise.resolve(invokeResult(channel, arg)));
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'org-id', currentUserId: 'user', people: [] } });
    await flushPromises();
    const textarea = wrapper.get('textarea');
    await textarea.setValue('private message');
    await textarea.trigger('keydown', { key: 'Enter' });
    expect(invoke).toHaveBeenCalledWith('conversation-servers:send-message', {
      serverId: 'public', channelId: 'public-channel', body: 'private message',
    });

    await selectServer(wrapper, 'Organization');
    finishSend();
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith('conversation-servers:send-message', {
      serverId: 'public', channelId: 'public-channel', body: 'private message',
    });
    wrapper.unmount();
  });

  it('routes a late old-composer input to its source draft, not the selected organization draft', async () => {
    // risk: draft integrity; late input from a public composer must not overwrite an organization draft
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'org-id', currentUserId: 'user', people: [] } });
    await flushPromises();
    const oldTextarea = wrapper.get('textarea').element as HTMLTextAreaElement;
    await selectServer(wrapper, 'Organization');
    const currentTextarea = wrapper.get('textarea');
    await currentTextarea.setValue('organization draft');

    oldTextarea.dataset.serverId = 'public';
    oldTextarea.dataset.channelId = 'public-channel';
    oldTextarea.value = 'late public input';
    oldTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();

    await selectServer(wrapper, 'Public');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('late public input');
    await selectServer(wrapper, 'Organization');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('organization draft');
    wrapper.unmount();
  });
});
