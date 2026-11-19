// SPDX-License-Identifier: GPL-2.0-or-later
// Opening the vault view during a cold start. The actual registered `vault:view-open` handler
// runs against a real ServiceLifecycleManager and the real VaultViewManager reservation logic;
// only the native WebContentsView load and the vault HTTP session are stubbed. Fake timers,
// so the 15s/28s/90s cold-start timeline runs instantly and nothing contacts a VM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  lifecycle:          null as any,
  createHumanSession: null as any,
}));

vi.mock('electron', () => {
  const app = { getPath: () => '/nonexistent', isPackaged: false, getVersion: () => '0.0.0-test' };

  return { default: { app, session: {} }, app, WebContentsView: class {} };
});
vi.mock('@pkg/utils/logging', () => {
  const log = { log() {}, debug() {}, info() {}, warn() {}, error() {}, sync() {} };

  return { default: new Proxy({}, { get: () => log }) };
});
vi.mock('@pkg/main/firstRun/firstRunTrace', () => ({ firstRunTrace: () => undefined }));
vi.mock('@pkg/main/vaultTls', () => ({ configureVaultPinnedSession: () => Promise.resolve(), VAULT_HTTPS_ORIGIN: 'https://vault.test' }));
vi.mock('@pkg/window', () => ({ getWindow: () => null }));
vi.mock('@pkg/agent/services/VaultKeyService', () => ({ getVaultKeyService: () => ({ refreshMasterCache: () => Promise.resolve() }) }));
vi.mock('@pkg/agent/services/DesktopVaultClient', () => ({ getDesktopVaultClient: () => ({ createHumanSession: (...args: unknown[]) => f.createHumanSession(...args) }) }));
// The handler reads the process singleton; each test gets its own real manager.
vi.mock('@pkg/agent/services/ServiceLifecycleManager', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@pkg/agent/services/ServiceLifecycleManager')>();

  return { ...actual, getServiceLifecycleManager: () => f.lifecycle };
});

import { ServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { MainProcessIpcContext } from '@pkg/main/startup/MainProcessIpcContext';
import { VAULT_VIEW_READY_TIMEOUT_MS, VaultViewIpc } from '@pkg/main/startup/VaultViewIpc';
import { VaultViewManager, type VaultViewReservation } from '@pkg/window/vaultViewManager';

/** Real reservation, ownership and hide logic; only the native view creation and load are skipped. */
class RecordingVaultViewManager extends VaultViewManager {
  readonly shown: string[] = [];

  override show(reservation: VaultViewReservation, _window: Electron.BrowserWindow, url: string): Promise<boolean> {
    if (!this.isCurrent(reservation)) return Promise.resolve(false);
    this.shown.push(`${ reservation.ownerId } ${ new URL(url).pathname }`);

    return Promise.resolve(this.isCurrent(reservation));
  }
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

const mainFrame = {};
const trustedContents = { mainFrame };
const vaultWindow = { id: 1, webContents: trustedContents, once: vi.fn(), isDestroyed: () => false, setContentProtection: vi.fn() } as unknown as Electron.BrowserWindow;
const trusted = { sender: trustedContents, senderFrame: mainFrame };
const bounds = { x: 0, y: 0, width: 800, height: 600 };

let handlers: Map<string, Handler>;
let views: RecordingVaultViewManager;
let ctx: MainProcessIpcContext;

async function registerHandlers(): Promise<void> {
  handlers = new Map();
  views = new RecordingVaultViewManager();
  ctx = new MainProcessIpcContext(
    { handle: (channel, listener) => { handlers.set(channel, listener) } },
    { getWindow: name => name === 'main-agent' ? vaultWindow : null },
    views,
    { publish: () => undefined } as any,
  );
  ctx.tabViewManager = { getTrustedMainFrameOrigin: () => null } as any;
  await new VaultViewIpc().register(ctx);
}

function open(ownerId: string, event: unknown = trusted) {
  const outcome: { settled: boolean; value?: any; error?: Error } = { settled: false };
  const promise = handlers.get('vault:view-open')!(event, bounds, { ownerId, surface: 'page' }).then(
    (value) => { Object.assign(outcome, { settled: true, value }) },
    (error) => { Object.assign(outcome, { settled: true, error }) },
  );

  return { outcome, promise };
}

/** The vault lifecycle service, registered late the way the backend does after the VM is up. */
function registerVault(options: { initMs?: number; fails?: boolean } = {}): void {
  f.lifecycle.register('vault', [], () => new Promise<void>((resolve, reject) => {
    setTimeout(() => options.fails ? reject(new Error('vault container exited')) : resolve(), options.initMs ?? 0);
  }), () => Promise.resolve(), { retry: !options.fails });
  f.lifecycle.startAll().catch(() => undefined);
}

beforeEach(async() => {
  vi.useFakeTimers();
  f.lifecycle = new ServiceLifecycleManager();
  f.createHumanSession = vi.fn(() => Promise.resolve({ url: 'https://vault.test/vault/index.html', expiresAt: 4_102_444_800_000 }));
  await registerHandlers();
});

afterEach(async() => {
  ctx.vaultStatus?.viewHidden();
  views.destroy();
  ctx.vaultStatus?.viewHidden();
  await f.lifecycle.stopAll();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('opening the vault view during a cold start', () => {
  it('keeps waiting past 15s and opens exactly once when the vault becomes ready at 28s', async() => {
    const { outcome, promise } = open('vault-tab');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(outcome.settled).toBe(false);

    // Lifecycle services are registered about 26s after launch; the vault itself needs about 2s more.
    await vi.advanceTimersByTimeAsync(11_000);
    registerVault({ initMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(outcome.settled).toBe(false);
    expect(f.createHumanSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toMatchObject({ state: 'opened' });
    expect(f.createHumanSession).toHaveBeenCalledTimes(1);
    expect(views.shown).toEqual(['vault-tab /vault/index.html']);
  });

  it('opens immediately when the vault is already ready', async() => {
    registerVault();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.lifecycle.isStarted('vault')).toBe(true);

    const { outcome, promise } = open('vault-tab');
    await promise;
    expect(outcome.value).toMatchObject({ state: 'opened' });
    expect(views.shown).toEqual(['vault-tab /vault/index.html']);
  });

  it('gives up honestly after the bounded 90s budget when the vault never becomes ready', async() => {
    expect(VAULT_VIEW_READY_TIMEOUT_MS).toBe(90_000);
    const { outcome, promise } = open('vault-tab');

    await vi.advanceTimersByTimeAsync(89_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(outcome.error?.message).toBe("Lifecycle service 'vault' did not become ready within 90000ms");
    expect(f.createHumanSession).not.toHaveBeenCalled();
    expect(views.shown).toEqual([]);
    // The failed owner releases its reservation.
    expect(views.hasActiveOwner()).toBe(false);
  });

  it('fails as soon as the vault start fails for good, without waiting out the budget', async() => {
    const { outcome, promise } = open('vault-tab');

    await vi.advanceTimersByTimeAsync(20_000);
    registerVault({ initMs: 1_000, fails: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(outcome.error?.message).toBe("Lifecycle service 'vault' failed to start");
    expect(f.createHumanSession).not.toHaveBeenCalled();
    expect(views.shown).toEqual([]);
    expect(views.hasActiveOwner()).toBe(false);
  });

  it('fails when the app shuts down while it waits, and does not open later', async() => {
    const { outcome, promise } = open('vault-tab');

    await vi.advanceTimersByTimeAsync(10_000);
    await f.lifecycle.stopAll();
    await promise;
    expect(outcome.error?.message).toBe("Lifecycle service 'vault' became unavailable during shutdown");
    registerVault();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.createHumanSession).not.toHaveBeenCalled();
    expect(views.shown).toEqual([]);
  });

  it('rejects an untrusted caller before reserving the view', async() => {
    registerVault();
    await vi.advanceTimersByTimeAsync(0);
    const otherFrame = {};
    const { outcome, promise } = open('vault-tab', { sender: { mainFrame: otherFrame }, senderFrame: otherFrame });
    await promise;
    expect(outcome.error?.message).toBe('Untrusted vault view caller');
    const subframe = open('vault-tab', { sender: trustedContents, senderFrame: {} });
    await subframe.promise;
    expect(subframe.outcome.error?.message).toBe('Untrusted vault view caller');
    expect(views.hasActiveOwner()).toBe(false);
    expect(f.createHumanSession).not.toHaveBeenCalled();
  });

  it('never shows a view for an owner replaced while it waited; only the newer owner opens', async() => {
    const first = open('vault-tab');
    await vi.advanceTimersByTimeAsync(20_000);
    const second = open('vault-popup');

    await vi.advanceTimersByTimeAsync(6_000);
    registerVault({ initMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([first.promise, second.promise]);
    expect(first.outcome.value).toEqual({ state: 'cancelled' });
    expect(second.outcome.value).toMatchObject({ state: 'opened' });
    expect(f.createHumanSession).toHaveBeenCalledTimes(1);
    expect(views.shown).toEqual(['vault-popup /vault/index.html']);
  });

  it('never shows a view for an owner hidden while it waited, even when the wait later times out', async() => {
    const hidden = open('vault-tab');
    await vi.advanceTimersByTimeAsync(5_000);
    await handlers.get('vault:view-hide')!(trusted, 'vault-tab');
    await vi.advanceTimersByTimeAsync(VAULT_VIEW_READY_TIMEOUT_MS);
    await hidden.promise;
    expect(hidden.outcome.value).toEqual({ state: 'cancelled' });

    const again = open('vault-tab');
    registerVault({ initMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await again.promise;
    expect(again.outcome.value).toMatchObject({ state: 'opened' });
    expect(views.shown).toEqual(['vault-tab /vault/index.html']);
  });

  it('leaves the lifecycle default wait at 15s for every other caller', async() => {
    let error: Error | undefined;
    const waiting = f.lifecycle.waitUntilStarted('vault').catch((cause: Error) => { error = cause });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(error?.message).toBe("Lifecycle service 'vault' did not become ready within 15000ms");
  });
});
