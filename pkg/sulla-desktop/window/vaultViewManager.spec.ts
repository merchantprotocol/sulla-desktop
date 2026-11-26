// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  default: { session: { fromPartition: vi.fn() } },
  WebContentsView: class {},
}));
vi.mock('./vaultPermissionPolicy', () => ({ VaultPermissionPolicy: class { } }));
vi.mock('@pkg/main/vaultTls', () => ({ configureVaultPinnedSession: vi.fn(), VAULT_HTTPS_ORIGIN: 'https://vault.test' }));

import { VaultViewManager } from './vaultViewManager';
import Logging from '@pkg/utils/logging';
import { VAULT_THEME_TOKENS } from '@pkg/shared/vaultTheme';

const makeView = () => ({
  setBounds: vi.fn(),
  webContents: {
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: () => false,
    close: vi.fn(),
    on: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue('theme-key'),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
  },
});

describe('VaultViewManager tab-host attachment', () => {
  it('keeps legacy single-renderer vault views attached to the window content view', async() => {
    // risk: the unlock/overlay path must continue working in the shared renderer
    const manager = new VaultViewManager() as any;
    const view = makeView();
    manager.createView = vi.fn().mockResolvedValue({ view, session: { clearStorageData: vi.fn() } });
    const window = { id: 3, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    const reservation = manager.reserve(window, 'legacy-owner');

    await expect(manager.show(reservation, window, 'https://vault.test/vault/unlock', { x: 8, y: 9, width: 200, height: 100 })).resolves.toBe(true);
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(manager.hide('legacy-owner', window)).toBe(true);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
    manager.destroy();
  });

  it('places the protected view above its tab and follows visibility and window bounds', async() => {
    // risk: the vault must not overlay the sidebar or remain attached to the window when opened in a tab
    const manager = new VaultViewManager() as any;
    const view = makeView();
    const session = { clearStorageData: vi.fn() };
    manager.createView = vi.fn().mockResolvedValue({ view, session });
    const window = {
      id: 1, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    let layout!: (bounds: Electron.Rectangle | null, raised: boolean) => void;
    let disposed: (() => void) | undefined;
    const stopLayout = vi.fn();
    const host = {
      observeLayout: (listener: typeof layout) => { layout = listener; layout(null, false); return stopLayout },
      onDisposed: (callback: () => void) => { disposed = callback; return vi.fn() },
    };
    const bounds = { x: 123, y: 45, width: 500, height: 400 };
    const reservation = manager.reserve(window, 'tab-owner');

    const theme = { dark: true, colors: Object.fromEntries(VAULT_THEME_TOKENS.map(token => [token, 'rgb(10, 25, 41)'])) };
    await expect(manager.show(reservation, window, 'https://vault.test/vault/home', bounds, host, theme)).resolves.toBe(true);
    const ready = view.webContents.on.mock.calls.find(([event]) => event === 'dom-ready')?.[1];
    expect(ready).toBeTypeOf('function');
    ready();
    await vi.waitFor(() => expect(view.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('color-scheme:dark')));
    expect(window.contentView.addChildView).not.toHaveBeenCalled();
    layout({ x: 180, y: 50, width: 600, height: 480 }, true);
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(window.setContentProtection).toHaveBeenLastCalledWith(true);
    expect(window.setContentProtection.mock.invocationCallOrder[0]).toBeLessThan(window.contentView.addChildView.mock.invocationCallOrder[0]);
    // The view keeps within the host bounds even when its renderer has not yet resized.
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 303, y: 95, width: 477, height: 400 });
    manager.setBounds('tab-owner', { ...bounds, width: 40 }, window);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 303, y: 95, width: 40, height: 400 });

    layout(null, false);
    expect(manager.hasOwnerView(window, 'tab-owner')).toBe(true);
    expect(manager.hasOwnerView(window, 'another-tab')).toBe(false);
    expect(window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(window.setContentProtection).toHaveBeenLastCalledWith(false);
    expect(view.webContents.close).not.toHaveBeenCalled();

    layout({ x: 199, y: 70, width: 700, height: 500 }, true);
    expect(window.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 322, y: 115, width: 40, height: 400 });
    expect(manager.hide('tab-owner', window)).toBe(true);
    expect(window.contentView.removeChildView).toHaveBeenCalledTimes(2);
    expect(stopLayout).toHaveBeenCalledOnce();
    expect(manager.hasOwnerView(window, 'tab-owner')).toBe(false);
    expect(view.webContents.close).not.toHaveBeenCalled();
    expect(session.clearStorageData).not.toHaveBeenCalled();
    expect(disposed).toBeDefined();

    const reopened = manager.reserve(window, 'tab-owner');
    await expect(manager.show(reopened, window, 'https://vault.test/vault/home?grant=next&csrf=next', { x: 4, y: 5, width: 600, height: 450 }, host, theme)).resolves.toBe(true);
    expect(manager.createView).toHaveBeenCalledOnce();
    expect(view.webContents.loadURL).toHaveBeenCalledOnce();
    layout({ x: 200, y: 50, width: 640, height: 500 }, true);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 204, y: 55, width: 600, height: 450 });

    const changedHint = manager.reserve(window, 'tab-owner');
    await expect(manager.show(changedHint, window, 'https://vault.test/vault/home?grant=third&csrf=third#connect=different', { x: 4, y: 5, width: 600, height: 450 }, host, theme)).resolves.toBe(true);
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(2);
    manager.destroy();
  });

  it('destroys a hidden renderer after the five-minute grace period', async() => {
    // risk: a hidden renderer must not retain the vault session indefinitely
    vi.useFakeTimers();
    try {
      const manager = new VaultViewManager() as any;
      const view = makeView();
      const session = { clearStorageData: vi.fn() };
      manager.createView = vi.fn().mockResolvedValue({ view, session });
      const window = { id: 5, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
      const reservation = manager.reserve(window, 'expiry-owner');
      await manager.show(reservation, window, 'https://vault.test/vault/home', { x: 0, y: 0, width: 300, height: 200 });
      manager.hide('expiry-owner', window);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(view.webContents.close).toHaveBeenCalledOnce();
      expect(session.clearStorageData).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('destroys the live renderer immediately when the vault locks', async() => {
    // risk: a locked vault must never leave a decrypted renderer available to reopen
    const manager = new VaultViewManager() as any;
    const view = makeView();
    const session = { clearStorageData: vi.fn() };
    manager.createView = vi.fn().mockResolvedValue({ view, session });
    const window = { id: 6, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    const reservation = manager.reserve(window, 'locked-owner');
    await manager.show(reservation, window, 'https://vault.test/vault/home', { x: 0, y: 0, width: 300, height: 200 });
    manager.destroy();
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(session.clearStorageData).toHaveBeenCalledOnce();
    expect(manager.hasActiveOwner()).toBe(false);
  });

  it('keeps the loading pane visible until the initial Vault theme is applied', async() => {
    const manager = new VaultViewManager() as any;
    const view = makeView();
    let finishNavigation!: () => void;
    let finishTheme!: (key: string) => void;
    view.webContents.loadURL.mockReturnValue(new Promise<void>(resolve => { finishNavigation = resolve }));
    view.webContents.insertCSS.mockReturnValue(new Promise<string>(resolve => { finishTheme = resolve }));
    manager.createView = vi.fn().mockResolvedValue({ view, session: { clearStorageData: vi.fn() } });
    const window = { id: 9, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn() } };
    const reservation = manager.reserve(window, 'paint-owner');
    const theme = { dark: true, colors: Object.fromEntries(VAULT_THEME_TOKENS.map(token => [token, 'rgb(10, 25, 41)'])) };
    const opened = manager.show(reservation, window, 'https://vault.test/vault/home', { x: 0, y: 0, width: 400, height: 300 }, undefined, theme);

    await vi.waitFor(() => expect(view.webContents.loadURL).toHaveBeenCalledOnce());
    expect(window.contentView.addChildView).not.toHaveBeenCalled();
    finishNavigation();
    await vi.waitFor(() => expect(view.webContents.insertCSS).toHaveBeenCalledOnce());
    expect(window.contentView.addChildView).not.toHaveBeenCalled();
    finishTheme('initial-theme');
    await expect(opened).resolves.toBe(true);
    expect(window.contentView.addChildView).toHaveBeenCalledOnce();
  });

  it('opens the vault unthemed when renderer theme colors are invalid', async() => {
    // risk: renderer CSS serialization must not prevent access to the password vault
    const manager = new VaultViewManager() as any;
    const view = makeView();
    manager.createView = vi.fn().mockResolvedValue({ view, session: { clearStorageData: vi.fn() } });
    const window = { id: 4, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    const reservation = manager.reserve(window, 'invalid-theme-owner');
    const warn = vi.spyOn(Logging.sulla, 'warn').mockImplementation(() => {});
    const theme = { dark: true, colors: Object.fromEntries(VAULT_THEME_TOKENS.map(token => [token, 'color(srgb 1 0 0)'])) };

    await expect(manager.show(reservation, window, 'https://vault.test/vault/home', { x: 0, y: 0, width: 400, height: 300 }, undefined, theme)).resolves.toBe(true);
    expect(manager.createView).toHaveBeenCalledOnce();
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://vault.test/vault/home');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid vault theme during open'), expect.any(Error));
    warn.mockRestore();
  });

  it('releases the vault view when its tab host crashes or closes', async() => {
    // risk: closing/crashing a tab must not retain a visible or orphaned password renderer
    const manager = new VaultViewManager() as any;
    const view = makeView();
    manager.createView = vi.fn().mockResolvedValue({ view, session: { clearStorageData: vi.fn() } });
    const window = { id: 2, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    let disposed!: () => void;
    const host = {
      observeLayout: (listener: (bounds: Electron.Rectangle, raised: boolean) => void) => {
        listener({ x: 110, y: 60, width: 530, height: 440 }, false);
        return vi.fn();
      },
      onDisposed: (listener: () => void) => { disposed = listener; return vi.fn() },
    };
    const reservation = manager.reserve(window, 'crashed-tab');
    await manager.show(reservation, window, 'https://vault.test/vault/home', { x: 1, y: 2, width: 300, height: 200 }, host);

    disposed();
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(manager.hasActiveOwner()).toBe(false);
  });

  it('closes a prepared vault renderer and clears its session when the open request is rejected', async() => {
    // risk: an unadopted password renderer and its isolated session would stay alive with no owner to close them
    const manager = new VaultViewManager() as any;
    manager.createView = vi.fn();
    const window = { id: 4, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    const home = 'https://vault.test/vault/home';
    const good = { x: 1, y: 2, width: 300, height: 200 };
    const rejected: [string, string, unknown, string][] = [
      ['non-finite bounds', home, { x: Number.NaN, y: 2, width: 300, height: 200 }, 'Invalid vault view bounds'],
      ['collapsed bounds', home, { x: 1, y: 2, width: 0, height: 200 }, 'Invalid vault view bounds'],
      ['a URL outside the vault', 'https://elsewhere.test/vault/home', good, 'Invalid vault UI URL'],
    ];
    for (const [name, url, bounds, message] of rejected) {
      const view = makeView();
      const session = { clearStorageData: vi.fn() };
      const reservation = manager.reserve(window, 'prepared-owner');
      await expect(manager.show(reservation, window, url, bounds, undefined, undefined, { view, session }), name).rejects.toThrow(message);
      expect(view.webContents.close, name).toHaveBeenCalledOnce();
      expect(session.clearStorageData, name).toHaveBeenCalledOnce();
      expect(view.webContents.loadURL, name).not.toHaveBeenCalled();
    }
    expect(window.contentView.addChildView).not.toHaveBeenCalled();
    expect(manager.createView).not.toHaveBeenCalled();

    // The same owner can still open with a fresh prepared view afterwards.
    const view = makeView();
    const reservation = manager.reserve(window, 'prepared-owner');
    await expect(manager.show(reservation, window, home, good, undefined, undefined, { view, session: { clearStorageData: vi.fn() } })).resolves.toBe(true);
    expect(view.webContents.close).not.toHaveBeenCalled();
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view);
    manager.destroy();
  });
});
