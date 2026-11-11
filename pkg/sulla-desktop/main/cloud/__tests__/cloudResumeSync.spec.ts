// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { CloudResumeSync } from '../cloudResumeSync';

function setup(overrides: { signedIn?: boolean; enabled?: boolean; vault?: boolean } = {}) {
  const files = { resetBackoff: vi.fn(), wake: vi.fn() };
  const vault = { syncNow: vi.fn(async () => ({})) };
  const sync = new CloudResumeSync({
    files,
    vault,
    preferences: async () => ({ enabled: overrides.enabled ?? true, vault: overrides.vault ?? true }),
    isSignedIn: () => overrides.signedIn ?? true,
  });
  return { files, vault, sync };
}

describe('CloudResumeSync', () => {
  it('on reconnect, resets the Files backoff, wakes Files and pushes pending Vault edits', async () => {
    // risk: data-accuracy — edits made offline must reach Cloud as soon as the network returns.
    const { files, vault, sync } = setup();
    await sync.handleOnline();
    expect(files.resetBackoff).toHaveBeenCalledTimes(1);
    expect(files.wake).toHaveBeenCalledTimes(1);
    expect(vault.syncNow).toHaveBeenCalledTimes(1);
  });

  it('skips Vault when the owner has turned the Vault copy off', async () => {
    // risk: privacy — a disabled Vault must not be pushed to Cloud.
    const { vault, sync } = setup({ vault: false });
    await sync.handleOnline();
    expect(vault.syncNow).not.toHaveBeenCalled();
  });

  it('does nothing while signed out or with cloud sync disabled', async () => {
    // risk: privacy — a signed-out or disabled device must not start cloud traffic.
    const signedOut = setup({ signedIn: false });
    await signedOut.sync.handleOnline();
    expect(signedOut.files.wake).not.toHaveBeenCalled();
    expect(signedOut.vault.syncNow).not.toHaveBeenCalled();

    const disabled = setup({ enabled: false });
    await disabled.sync.handleOnline();
    expect(disabled.files.wake).not.toHaveBeenCalled();
    expect(disabled.vault.syncNow).not.toHaveBeenCalled();
  });
});
