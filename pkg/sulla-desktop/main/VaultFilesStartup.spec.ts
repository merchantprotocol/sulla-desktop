// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { VaultFilesStartup } from './VaultFilesStartup';

describe('VaultFilesStartup', () => {
  it('does not become ready until Files is unlocked and the mount token is written', () => {
    // risk: availability — lifecycle must not report Files ready while locked or without mount credentials.
    const startup = new VaultFilesStartup();

    startup.vaultUnlocking();
    expect(startup.snapshot().phase).toBe('vault-unlocking');
    expect(startup.isReady()).toBe(false);
    startup.filesUnlocking();
    expect(startup.isReady()).toBe(false);
    startup.filesUnlocked();
    expect(startup.isReady()).toBe(false);
    startup.mountTokenWritten();
    expect(startup.isReady()).toBe(true);
    startup.vaultLocked();
    expect(startup.snapshot()).toMatchObject({ phase: 'vault-locked', ready: false, mountTokenWritten: false });
  });

  it('retains Files readiness while recording an optional native-source degradation', () => {
    // risk: availability — a native-only failure must not gate Files after its mount credential exists.
    const startup = new VaultFilesStartup();

    startup.filesUnlocking();
    startup.filesUnlocked();
    startup.mountTokenWritten();
    startup.degrade('Native source revalidation unavailable');

    expect(startup.snapshot()).toMatchObject({ phase: 'degraded', ready: true, filesUnlocked: true, mountTokenWritten: true });
  });

  it('is ready without a mount token when the guest mount is disabled by design, and requires it again after a relock', () => {
    const startup = new VaultFilesStartup();

    startup.filesUnlocking();
    startup.filesUnlocked();
    expect(startup.isReady()).toBe(false);
    startup.mountNotRequired();
    expect(startup.isReady()).toBe(true);
    startup.vaultLocked();
    startup.filesUnlocking();
    startup.filesUnlocked();
    expect(startup.isReady()).toBe(false);
  });
});
