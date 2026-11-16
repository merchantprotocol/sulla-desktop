// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { isContainerLifecycleLost } from '../../../languagemodels/cliFaultRecovery';
import { classifyLLMFailure } from '../../../languagemodels/providerRecovery';
import { GuestDiskFullError } from '../../../services/GuestDiskFullError';
import { ContainerProviderFileTransport } from '../../../services/ContainerProviderFileTransport';
import * as guest from '../../../services/GuestRuntimeTransport';

vi.mock('../../../services/GuestRuntimeTransport', () => ({
  GUEST_PROVIDER_FILES_ROOT:   '/mnt/data/sulla/runtime/provider-transport',
  createGuestRuntimeDirectory: vi.fn(async() => '/mnt/data/sulla/runtime/provider-transport/container-test'),
  chmodGuestPath:              vi.fn(async() => {}),
  removeGuestPathAtomic:       vi.fn(async() => {}),
  writeGuestFileAtomic:        vi.fn(async() => {}),
}));

describe('container provider files after the lifecycle ends', () => {
  it('reports a late write as a lifecycle loss instead of writing into a removed directory', async() => {
    // risk: observers that outlive a job retrying 3x per model on "nonexistent directory"
    const files = await ContainerProviderFileTransport.create();
    await files.write({ purpose: 'system-prompt', suggestedName: 'p.md', data: 'prompt' } as any);
    await files.dispose();
    vi.mocked(guest.writeGuestFileAtomic).mockClear();

    const error = await files.write({ purpose: 'system-prompt', suggestedName: 'p.md', data: 'prompt' } as any).catch(e => e);
    expect(isContainerLifecycleLost(error)).toBe(true);
    expect(guest.writeGuestFileAtomic).not.toHaveBeenCalled();
  });
});

describe('guest disk full', () => {
  it('turns ENOSPC from a guest write into one non-retryable Sulla failure', () => {
    // risk: a full VM disk retried and failed over across every model candidate
    const error = GuestDiskFullError.fromGuestFailure(
      'sulla-guest-write: line 0: can\'t create /mnt/data/sulla/runtime/provider-transport/x/.p.md.next-1: No space left on device', 'exit 2');
    expect(error).toBeInstanceOf(GuestDiskFullError);
    const recovery = classifyLLMFailure(error);
    expect(recovery.kind).toBe('infrastructure');
    expect(recovery.retryPrimary).toBe(false);
    expect(recovery.fallbackAllowed).toBe(false);
  });

  it('keeps other guest failures as ordinary errors', () => {
    // risk: misreporting an unrelated failure as a full disk
    const error = GuestDiskFullError.fromGuestFailure('can\'t create /mnt/x: nonexistent directory', 'exit 2');
    expect(error).not.toBeInstanceOf(GuestDiskFullError);
    expect(GuestDiskFullError.fromGuestFailure('', 'Guest command exited 2').message).toBe('Guest command exited 2');
  });
});
