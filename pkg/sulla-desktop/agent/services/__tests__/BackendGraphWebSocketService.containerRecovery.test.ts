// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, jest } from '@jest/globals';

import { ContainerLifecycleLostError } from '../../languagemodels/cliFaultRecovery';

describe('conversation container recovery', () => {
  it('rebuilds a vanished lifecycle and retries the same provider action once', async() => {
    const { executeWithContainerLifecycleRecovery } = await import('../ContainerLifecycleRecovery');
    const first = { execute: (action: () => unknown) => action(), close: jest.fn(), containerName: 'old', workspacePath: '/work' };
    const rebuilt = { execute: (action: () => unknown) => action(), close: jest.fn(), containerName: 'new', workspacePath: '/work' };
    const acquire = jest.fn(async() => first as any);
    const recover = jest.fn(async(lost: any) => {
      expect(lost).toBe(first);
      return rebuilt as any;
    });
    let calls = 0;
    const providerCall = jest.fn(async() => {
      calls += 1;
      if (calls === 1) throw new ContainerLifecycleLostError(new Error('docker exec: No such container: old'));
      return 'same-provider-success';
    });

    await expect(executeWithContainerLifecycleRecovery(acquire, recover, providerCall as any))
      .resolves.toBe('same-provider-success');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(providerCall).toHaveBeenCalledTimes(2);
  });
});
