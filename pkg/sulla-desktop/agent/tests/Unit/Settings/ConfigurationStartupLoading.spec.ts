// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';

const { openVault, invoke } = vi.hoisted(() => ({ openVault: vi.fn(), invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => channel === 'vault:view-open' ? openVault(...args) : invoke(channel, ...args),
  },
}));
vi.mock('@pkg/composables/useTheme', () => ({ useTheme: () => ({ currentTheme: ref('dark') }) }));
vi.mock('@pkg/shared/vaultTheme', () => ({ readVaultTheme: () => ({}) }));
vi.mock('@pkg/composables/useDatabaseAvailableReload', () => ({ useDatabaseAvailableReload: vi.fn() }));

import { ConfigurationLoadPolicy, useConfigurationLoad } from '@pkg/composables/useConfigurationLoad';
import { useRoutines } from '@pkg/composables/useRoutines';
import VaultPage from '@pkg/pages/VaultPage.vue';

describe('configuration startup', () => {
  let vault: VueWrapper | undefined;
  let setDocumentHidden: (hidden: boolean) => void;
  let pageScope: ReturnType<typeof effectScope>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    setDocumentHidden = (value) => { hidden.mockReturnValue(value) };
    pageScope = effectScope();
  });

  afterEach(() => {
    vault?.unmount();
    vault = undefined;
    pageScope.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    openVault.mockReset();
    invoke.mockReset();
  });

  it('keeps loading until the dependency actually responds, then stops checking', async() => {
    const load = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("Error invoking remote method 'model-routing:get': Error: Connection terminated due to connection timeout"))
      .mockResolvedValue(undefined);
    const state = pageScope.run(() => useConfigurationLoad(load))!;

    await state.start();
    expect(state.loading.value).toBe(true);
    expect(state.error.value).toBe('');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.loading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.loading.value).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('stops retrying when the page closes', async() => {
    const load = vi.fn().mockResolvedValue(false);
    const state = pageScope.run(() => useConfigurationLoad(load))!;
    await state.start();
    pageScope.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('surfaces a genuine error without polling it', async() => {
    const load = vi.fn().mockRejectedValue(new Error('Vault is locked'));
    const state = pageScope.run(() => useConfigurationLoad(load))!;
    await state.start();
    expect(state.error.value).toBe('Vault is locked');
    expect(state.loading.value).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(new ConfigurationLoadPolicy().isVaultLocked(state.error.value)).toBe(true);
  });

  it('leaves a visible Vault loading screen on cancellation and opens automatically after readiness', async() => {
    openVault.mockResolvedValueOnce({ state: 'cancelled' })
      .mockRejectedValueOnce(new Error('Service "vault" did not become ready within 90000ms'))
      .mockResolvedValueOnce({ state: 'opened', expiresAt: Date.now() + 60_000 });
    vault = mount(VaultPage);

    await flushPromises();
    expect(vault.get('[role=status]').text()).toBe('Waiting for Password Vault…');
    expect(vault.find('button').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vault.get('[role=status]').text()).toBe('Waiting for Password Vault…');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vault.find('[role=status]').exists()).toBe(false);
    expect(vault.find('[role=alert]').exists()).toBe(false);
    expect(openVault).toHaveBeenCalledTimes(3);
  });

  it('does not reopen the native Vault while the tab is hidden', async() => {
    openVault.mockResolvedValueOnce({ state: 'cancelled' }).mockResolvedValueOnce({ state: 'opened' });
    vault = mount(VaultPage);
    await flushPromises();
    setDocumentHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openVault).toHaveBeenCalledTimes(1);

    setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(openVault).toHaveBeenCalledTimes(2);
    expect(vault.find('[role=status]').exists()).toBe(false);
  });

  it('loads saved workflows after startup instead of presenting the unavailable list as empty', async() => {
    invoke.mockRejectedValueOnce(new Error('Workflows are temporarily unavailable while the database reconnects.'))
      .mockResolvedValueOnce([{ id: 'saved-workflow', name: 'Saved workflow', status: 'draft', updatedAt: new Date().toISOString() }]);
    const routines = pageScope.run(() => useRoutines())!;

    await routines.load();
    expect(invoke).toHaveBeenCalledWith('workflow-db-list', { strict: true });
    expect(routines.isLoading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(routines.isLoading.value).toBe(false);
    expect(routines.routines.value.map(workflow => workflow.id)).toEqual(['saved-workflow']);
  });
});
