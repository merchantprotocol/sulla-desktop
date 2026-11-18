// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { VaultUnreachable } from '../../../languagemodels/failures';
import { VaultUnreachableRecovery } from '../../../languagemodels/vaultGate';

import type { VaultGate } from '../../../languagemodels/vaultGate';

const gate = (available: boolean): VaultGate => ({
  failureSince: () => undefined,
  waitUntilAvailable: vi.fn(async() => available),
});

describe('VaultUnreachableRecovery', () => {
  // risk: users lose an in-flight turn during a transient vault/runtime restart
  it('waits for vault availability, then replays the same primary operation once', async() => {
    const vault = gate(true);
    const replayPrimary = vi.fn(async() => 'recovered');

    await expect(new VaultUnreachableRecovery(vault).replayPrimary(new VaultUnreachable(), replayPrimary))
      .resolves.toBe('recovered');
    expect(vault.waitUntilAvailable).toHaveBeenCalledTimes(1);
    expect(replayPrimary).toHaveBeenCalledTimes(1);
  });

  // risk: users see a generic provider error instead of the actual vault outage
  it('preserves the original vault message when the bounded wait times out', async() => {
    const vault = gate(false);
    const replayPrimary = vi.fn(async() => 'must not run');
    const failure = new VaultUnreachable();

    await expect(new VaultUnreachableRecovery(vault).replayPrimary(failure, replayPrimary)).rejects.toBe(failure);
    expect(replayPrimary).not.toHaveBeenCalled();
  });

  // risk: replaying an uncertain CLI operation repeats an external side effect
  it('does not replay after the caller reports an uncertain side effect', async() => {
    const replayPrimary = vi.fn(async() => 'must not run');
    const failure = new VaultUnreachable();

    await expect(new VaultUnreachableRecovery(gate(true)).replayPrimary(failure, replayPrimary, undefined, true)).rejects.toBe(failure);
    expect(replayPrimary).not.toHaveBeenCalled();
  });
});
