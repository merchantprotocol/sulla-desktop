// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), invoke: vi.fn() }, default: {} }));

import { OAuthVaultGate, type OAuthVaultGateIpc } from './useOAuthConnection';

class FakeOAuthVaultIpc implements OAuthVaultGateIpc {
  readonly listeners = new Map<string, (...args: any[]) => void>();
  readonly invoke = vi.fn(async(channel: string) => channel === 'vault:status' ? { unlocked: false } : true);
  on(channel: string, listener: (...args: any[]) => void): void { this.listeners.set(channel, listener) }
  removeListener(channel: string): void { this.listeners.delete(channel) }
}

describe('OAuthVaultGate', () => {
  it('raises the unlock surface and does not continue until the vault reports unlocked', async() => {
    // risk: authorization — OAuth credentials must not arrive when they cannot be saved to the vault.
    const ipc = new FakeOAuthVaultIpc();
    const pending = new OAuthVaultGate(ipc).waitUntilUnlocked();
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.invoke).toHaveBeenCalledWith('vault:unlock-required');
    let completed = false;
    void pending.then(() => { completed = true });
    expect(completed).toBe(false);
    ipc.listeners.get('vault:logged-in')?.();
    await pending;
    expect(completed).toBe(true);
    expect(ipc.listeners.has('vault:logged-in')).toBe(false);
  });

  it('does not require unlock during first-run credential setup', async() => {
    // risk: availability — first-run sign-in can proceed before a user vault exists.
    const ipc = new FakeOAuthVaultIpc();
    await new OAuthVaultGate(ipc).waitUntilUnlocked(true);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});
