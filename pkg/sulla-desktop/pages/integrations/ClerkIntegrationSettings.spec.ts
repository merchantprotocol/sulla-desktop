// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
//
// risk: a failed Clerk save must never look like success or throw away what the user typed.

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args) } }));

import ClerkIntegrationSettings from './ClerkIntegrationSettings.vue';

const section = (connected: boolean) => ({ connected, publishableKey: connected ? 'pk_test_SAVED' : '', instanceId: connected ? 'ins_a' : '' });
const settings = (staging: boolean, production: boolean) => ({ staging: section(staging), production: section(production) });
const STAGING_PK = 'pk_test_TYPEDFIXTURE';
const STAGING_SK = 'sk_test_TYPEDFIXTURE';
const PROD_PK = 'pk_live_TYPEDFIXTURE';
const PROD_SK = 'sk_live_TYPEDFIXTURE';
const PROD_ERROR = 'Production: the secret key is malformed (it has unexpected characters). Copy it again from the Clerk dashboard.';

async function mounted() {
  const wrapper = mount(ClerkIntegrationSettings);
  await flushPromises();
  const inputs = wrapper.findAll('input');
  await inputs[0].setValue(STAGING_PK);
  await inputs[1].setValue(STAGING_SK);
  await inputs[2].setValue(PROD_PK);
  await inputs[3].setValue(PROD_SK);
  return wrapper;
}

describe('Clerk settings panel save outcomes', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'clerk:settings:load'
      ? { success: true, settings: settings(false, false), allowedAgentIds: [] }
      : channel === 'agent-definitions:list'
        ? [{ slug: 'research-agent', name: 'Research Agent', enabled: true, status: 'production' }]
        : undefined));
  });

  it('keeps the failed section typed, clears the confirmed one, and raises the failure as an alert', async() => {
    const wrapper = await mounted();
    invoke.mockResolvedValueOnce({
      success: false, error: PROD_ERROR, settings: settings(true, false),
      sections: { staging: { saved: true }, production: { saved: false, error: PROD_ERROR } },
    });
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(invoke).toHaveBeenLastCalledWith('clerk:settings:save', {
      staging_publishable_key: STAGING_PK, staging_secret_key: STAGING_SK,
      production_publishable_key: PROD_PK, production_secret_key: PROD_SK,
    });
    const values = wrapper.findAll('input[type="text"], input[type="password"]').map(input => (input.element as HTMLInputElement).value);
    expect(values).toEqual(['', '', PROD_PK, PROD_SK]);
    expect(wrapper.get('[role="alert"]').text()).toBe(PROD_ERROR);
    expect(wrapper.get('[role="status"]').text()).toBe('Staging saved and connected.');
    expect(wrapper.emitted('changed')?.at(-1)).toEqual([true]);
  });

  it('keeps everything typed when the save call itself fails', async() => {
    const wrapper = await mounted();
    invoke.mockRejectedValueOnce(new Error('ipc down'));
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const values = wrapper.findAll('input[type="text"], input[type="password"]').map(input => (input.element as HTMLInputElement).value);
    expect(values).toEqual([STAGING_PK, STAGING_SK, PROD_PK, PROD_SK]);
    expect(wrapper.get('[role="alert"]').text()).toContain('unavailable');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('reports success only for a confirmed save and clears the submitted keys', async() => {
    const wrapper = await mounted();
    invoke.mockResolvedValueOnce({ success: true, settings: settings(true, true), sections: { staging: { saved: true }, production: { saved: true } } });
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.findAll('input[type="text"], input[type="password"]').map(input => (input.element as HTMLInputElement).value)).toEqual(['', '', '', '']);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toBe('Staging and Production saved and connected.');
  });

  it('saves the selected agent IDs through the Clerk settings path without sending keys', async() => {
    const wrapper = await mounted();
    expect(invoke).toHaveBeenCalledWith('agent-definitions:list', { strict: true });
    invoke.mockResolvedValueOnce({ success: true, settings: settings(false, false), allowedAgentIds: ['research-agent'] });
    const accessModes = wrapper.findAll('input[type="radio"]');
    await accessModes[1].setValue();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    const saveAccess = wrapper.findAll('button').find(button => button.text().includes('Save agent access'))!;
    await saveAccess.trigger('click');
    await flushPromises();

    expect(invoke).toHaveBeenLastCalledWith('clerk:settings:save', { allowedAgentIds: ['research-agent'] });
  });

  it('uses the empty allow list to preserve the all-agents default', async() => {
    const wrapper = await mounted();
    invoke.mockResolvedValueOnce({ success: true, settings: settings(false, false), allowedAgentIds: [] });
    const saveAccess = wrapper.findAll('button').find(button => button.text().includes('Save agent access'))!;
    await saveAccess.trigger('click');
    await flushPromises();

    expect(invoke).toHaveBeenLastCalledWith('clerk:settings:save', { allowedAgentIds: [] });
  });
});
