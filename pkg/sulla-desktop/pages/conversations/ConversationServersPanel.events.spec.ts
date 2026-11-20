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
  if (channel === 'org-conversations:organizations') return [{ orgId: 'org-id', name: 'Organization' }];
  if (channel === 'conversation-servers:list') return (arg as string | undefined) === 'org-id' ? [orgServer] : [publicServer];
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

  it('keeps DMs as the starting view and groups public servers before organization servers', async () => {
    // risk: navigation; an organization server must not appear in the public group or replace DMs on entry
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'org-id', currentUserId: 'user', people: [] }, slots: { default: '<div data-test="dm-view">DM inbox</div>' } });
    await flushPromises();
    expect(wrapper.find('[data-test="dm-view"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Direct messages and People"]').classes()).toContain('selected');
    expect(wrapper.find('.cs-group').text()).toBe('Public');
    expect(wrapper.findAll('.cs-server-icon.cs-public').map(button => button.attributes('aria-label'))).toEqual(['Public server']);
    expect(wrapper.findAll('.cs-server-icon.cs-org').map(button => button.attributes('aria-label'))).toEqual(['Organization server']);
    expect(wrapper.find('.cs-server-add[aria-label="Create server"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('creates a public server without an orgId', async () => {
    // risk: tenant isolation; public creation must not inherit or send an organization scope
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'current-org', currentUserId: 'user', people: [] } });
    await flushPromises();
    invoke.mockImplementation((channel: string, arg?: unknown) => channel === 'conversation-servers:create'
      ? Promise.resolve({ id: 'created-public', name: 'Open community', visibility: 'public', ownerUserId: 'user' })
      : Promise.resolve(invokeResult(channel, arg)));
    await wrapper.get('.cs-server-add').trigger('click');
    expect(wrapper.get('form[aria-label="Create server"]').exists()).toBe(true);
    await wrapper.get('input').setValue('  Open community  ');
    await wrapper.get('form[aria-label="Create server"]').trigger('submit');
    expect(invoke).toHaveBeenCalledWith('conversation-servers:create', { name: 'Open community', visibility: 'public' });
    wrapper.unmount();
  });

  it('creates an organization server using only a membership-backed organization option', async () => {
    // risk: tenant isolation; organization creation must use an authorized membership and its exact orgId
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'current-org', currentUserId: 'user', people: [] } });
    await flushPromises();
    invoke.mockImplementation((channel: string, arg?: unknown) => channel === 'org-conversations:organizations'
      ? Promise.resolve([{ orgId: 'member-org', name: 'Member org', memberCount: 2 }])
      : channel === 'conversation-servers:create'
        ? Promise.resolve({ id: 'created-org', name: 'Team hub', visibility: 'organization', orgId: 'member-org', ownerUserId: 'user' })
        : Promise.resolve(invokeResult(channel, arg)));
    // Refresh membership-backed org options before opening the dialog.
    await wrapper.setProps({ orgId: 'updated-org' });
    await flushPromises();
    await wrapper.get('.cs-server-add').trigger('click');
    await wrapper.get('input').setValue('Team hub');
    await wrapper.get('select').setValue('organization');
    const orgSelect = wrapper.findAll('select')[1];
    expect(orgSelect.findAll('option').map(option => option.text())).toEqual(['Member org']);
    await orgSelect.setValue('member-org');
    await wrapper.get('form[aria-label="Create server"]').trigger('submit');
    expect(invoke).toHaveBeenCalledWith('conversation-servers:create', {
      name: 'Team hub', visibility: 'organization', orgId: 'member-org',
    });
    wrapper.unmount();
  });

  it('does not invoke IPC for a blank name or a missing organization selection', async () => {
    // risk: invalid tenant-scoped writes; blank names and absent membership selections must be rejected
    invoke.mockImplementation((channel: string, arg?: unknown) => Promise.resolve(
      channel === 'org-conversations:organizations' ? [] : invokeResult(channel, arg),
    ));
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'current-org', currentUserId: 'user', people: [] } });
    await flushPromises();
    await wrapper.get('.cs-server-add').trigger('click');
    await wrapper.get('input').setValue('   ');
    await wrapper.get('form[aria-label="Create server"]').trigger('submit');
    expect(invoke).not.toHaveBeenCalledWith('conversation-servers:create', expect.anything());

    await wrapper.get('input').setValue('No organization');
    await wrapper.get('select').setValue('organization');
    await wrapper.get('form[aria-label="Create server"]').trigger('submit');
    expect(invoke).not.toHaveBeenCalledWith('conversation-servers:create', expect.anything());
    wrapper.unmount();
  });

  it('opens the selected server channel view and pins Back to the bottom of the rail', async () => {
    // risk: navigation; server selection must load that server's channels without losing the rail exit
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'org-id', currentUserId: 'user', people: [] } });
    await flushPromises();
    await wrapper.get('[aria-label="Organization server"]').trigger('click');
    // The Channels container mounts immediately on selection, before async channels/preferences resolve.
    await vi.waitFor(() => expect(wrapper.find('[aria-label="team, notifications All messages"]').exists()).toBe(true));
    expect(wrapper.get('.cs-rail').element.lastElementChild?.getAttribute('aria-label')).toBe('Back');
    await wrapper.get('[aria-label="Back"]').trigger('click');
    expect(wrapper.emitted('exit')).toHaveLength(1);
    wrapper.unmount();
  });

  it('sends Enter to the composer source channel even after selection changes', async () => {
    // risk: privacy; an async channel switch must not redirect a message to a different destination
    let finishSend!: () => void;
    invoke.mockImplementation((channel: string, arg?: unknown) => channel === 'conversation-servers:send-message'
      ? new Promise(resolve => { finishSend = () => resolve(undefined); })
      : Promise.resolve(invokeResult(channel, arg)));
    const wrapper = mount(ConversationServersPanel, { props: { orgId: 'org-id', currentUserId: 'user', people: [] } });
    await flushPromises();
    await selectServer(wrapper, 'Public');
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
    await selectServer(wrapper, 'Public');
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
