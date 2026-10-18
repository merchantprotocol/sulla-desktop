import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const configureResolvers: Array<() => void> = [];
const sessions: any[] = [];
const views: any[] = [];

const mainWindow = {
  contentView: {
    addChildView:    jest.fn(),
    removeChildView: jest.fn(),
  },
  setContentProtection: jest.fn(),
};

jest.unstable_mockModule('@pkg/window', () => ({ getWindow: jest.fn(() => mainWindow) }));
jest.unstable_mockModule('@pkg/main/vaultTls', () => ({
  VAULT_HTTPS_ORIGIN: 'https://vault.test',
  configureVaultPinnedSession: jest.fn(() => new Promise<void>((resolve) => {
    configureResolvers.push(resolve);
  })),
}));
jest.unstable_mockModule('electron', () => {
  const fromPartition = jest.fn(() => {
    const session = {
      clearStorageData:            jest.fn(() => Promise.resolve()),
      setPermissionCheckHandler:   jest.fn(),
      setPermissionRequestHandler: jest.fn(),
      webRequest: {
        onBeforeRequest:   jest.fn(),
        onHeadersReceived: jest.fn(),
      },
    };
    sessions.push(session);
    return session;
  });
  const WebContentsView = jest.fn(() => {
    const view = {
      setBounds:   jest.fn(),
      webContents: {
        close:                    jest.fn(),
        isDestroyed:              jest.fn(() => false),
        loadURL:                  jest.fn(() => Promise.resolve()),
        on:                       jest.fn(),
        setWindowOpenHandler:     jest.fn(),
      },
    };
    views.push(view);
    return view;
  });

  return {
    default: { session: { fromPartition } },
    session: { fromPartition },
    WebContentsView,
  };
});

describe('VaultViewManager lifecycle ownership', () => {
  beforeEach(() => {
    configureResolvers.splice(0);
    sessions.splice(0);
    views.splice(0);
    jest.clearAllMocks();
  });

  it('cancels a hidden pending open and ignores a stale owner after replacement', async() => {
    const { VaultViewManager } = await import('../vaultViewManager');
    const manager = new VaultViewManager();
    const oldReservation = manager.reserve('owner-old');
    const oldOpen = manager.show(oldReservation, 'https://vault.test/vault/', { x: 0, y: 0, width: 800, height: 600 });

    await Promise.resolve();
    manager.hide('owner-old');
    const newReservation = manager.reserve('owner-new');
    expect(manager.hide('owner-old')).toBe(false);
    expect(manager.hasActiveOwner()).toBe(true);
    configureResolvers.shift()?.();

    await expect(oldOpen).resolves.toBe(false);
    expect(mainWindow.contentView.addChildView).not.toHaveBeenCalled();
    expect(views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(sessions[0].clearStorageData).toHaveBeenCalledTimes(1);

    const newOpen = manager.show(newReservation, 'https://vault.test/vault/', { x: 10, y: 20, width: 640, height: 480 });
    await Promise.resolve();
    configureResolvers.shift()?.();

    await expect(newOpen).resolves.toBe(true);
    expect(mainWindow.contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(mainWindow.contentView.removeChildView).not.toHaveBeenCalled();
    expect(manager.hasActiveOwner()).toBe(true);
  });

  it('discards a view that finishes creating after manager destruction', async() => {
    const { VaultViewManager } = await import('../vaultViewManager');
    const manager = new VaultViewManager();
    const reservation = manager.reserve('owner-destroyed');
    const pendingOpen = manager.show(reservation, 'https://vault.test/vault/', { x: 0, y: 0, width: 800, height: 600 });

    await Promise.resolve();
    manager.destroy();
    configureResolvers.shift()?.();

    await expect(pendingOpen).resolves.toBe(false);
    expect(mainWindow.contentView.addChildView).not.toHaveBeenCalled();
    expect(views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(sessions[0].clearStorageData).toHaveBeenCalledTimes(1);
    expect(manager.hasActiveOwner()).toBe(false);
  });
});
