// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { ServiceLifecycleManager } from './ServiceLifecycleManager';

describe('ServiceLifecycleManager runtime readiness gate', () => {
  it('keeps an initialized service non-ready until its live readiness source passes', async() => {
    // risk: availability — Files must not report ready while locked or without a mount token.
    const lifecycle = new ServiceLifecycleManager();
    let ready = false;

    lifecycle.register('files-runtime', [], async() => undefined, async() => undefined, {
      readiness: () => ready,
      readinessReason: () => 'Waiting for Files mount token',
    });
    await lifecycle.startAll();
    expect(lifecycle.serviceStatuses()[0]).toMatchObject({ status: 'starting', reason: 'Waiting for Files mount token' });

    ready = true;
    await lifecycle.retryService('files-runtime');
    expect(lifecycle.serviceStatuses()[0]).toMatchObject({ status: 'ready' });
    await lifecycle.stopAll();
  });
});
