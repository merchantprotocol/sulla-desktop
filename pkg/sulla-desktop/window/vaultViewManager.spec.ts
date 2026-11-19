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
import { VAULT_THEME_TOKENS } from '@pkg/shared/vaultTheme';

const makeView = () => ({
  setBounds: vi.fn(),
  webContents: {
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: () => false,
    close: vi.fn(),
    on: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue('theme-key'),
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
  });

  it('attaches with tab-relative bounds and detaches from that host on hide', async() => {
    // risk: the vault must not overlay the sidebar or remain attached to the window when opened in a tab
    const manager = new VaultViewManager() as any;
    const view = makeView();
    const session = { clearStorageData: vi.fn() };
    manager.createView = vi.fn().mockResolvedValue({ view, session });
    const window = {
      id: 1, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    const host = { addChildView: vi.fn(), removeChildView: vi.fn() };
    let disposed: (() => void) | undefined;
    const onDisposed = (callback: () => void) => { disposed = callback; return vi.fn() };
    const bounds = { x: 123, y: 45, width: 500, height: 400 };
    const reservation = manager.reserve(window, 'tab-owner');

    const theme = { dark: true, colors: Object.fromEntries(VAULT_THEME_TOKENS.map(token => [token, 'rgb(10, 25, 41)'])) };
    await expect(manager.show(reservation, window, 'https://vault.test/vault/home', bounds, host, onDisposed, theme)).resolves.toBe(true);
    const ready = view.webContents.on.mock.calls.find(([event]) => event === 'dom-ready')?.[1];
    expect(ready).toBeTypeOf('function');
    ready();
    await vi.waitFor(() => expect(view.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('color-scheme:dark')));
    expect(host.addChildView).toHaveBeenCalledWith(view);
    expect(view.setBounds).toHaveBeenCalledWith(bounds);
    expect(window.contentView.addChildView).not.toHaveBeenCalled();

    expect(manager.hide('tab-owner', window)).toBe(true);
    expect(host.removeChildView).toHaveBeenCalledWith(view);
    expect(window.contentView.removeChildView).not.toHaveBeenCalled();
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(session.clearStorageData).toHaveBeenCalledOnce();
    expect(disposed).toBeDefined();
  });

  it('opens the vault unthemed when renderer theme colors are invalid', async() => {
    // risk: renderer CSS serialization must not prevent access to the password vault
    const manager = new VaultViewManager() as any;
    const view = makeView();
    manager.createView = vi.fn().mockResolvedValue({ view, session: { clearStorageData: vi.fn() } });
    const window = { id: 4, isDestroyed: () => false, once: vi.fn(), setContentProtection: vi.fn(), contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } };
    const reservation = manager.reserve(window, 'invalid-theme-owner');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const theme = { dark: true, colors: Object.fromEntries(VAULT_THEME_TOKENS.map(token => [token, 'color(srgb 1 0 0)'])) };

    await expect(manager.show(reservation, window, 'https://vault.test/vault/home', { x: 0, y: 0, width: 400, height: 300 }, undefined, undefined, theme)).resolves.toBe(true);
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
    const host = { addChildView: vi.fn(), removeChildView: vi.fn() };
    let disposed!: () => void;
    const reservation = manager.reserve(window, 'crashed-tab');
    await manager.show(reservation, window, 'https://vault.test/vault/home', { x: 1, y: 2, width: 300, height: 200 }, host,
      (listener: () => void) => { disposed = listener; return vi.fn() });

    disposed();
    expect(host.removeChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(manager.hasActiveOwner()).toBe(false);
  });
});
