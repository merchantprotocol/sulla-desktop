// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/logging', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  return { __esModule: true, default: { sulla: logger } };
});

const { ServiceLifecycleManager } = await import('@pkg/agent/services/ServiceLifecycleManager');
const { StartupProgressHub } = await import('../startupProgressHub');

describe('ServiceLifecycleManager startup events', () => {
  it('emits begin plus start/ready/failed steps in order, and keeps starting after a failure', async() => {
    const lifecycle = new ServiceLifecycleManager();
    const events: string[] = [];

    lifecycle.on('startup:begin', (e: any) => events.push(`begin:${ e.order.join(',') }:${ e.alreadyStarted.join(',') }`));
    lifecycle.on('startup:step', (e: any) => events.push(`${ e.name }:${ e.status }${ e.error ? `:${ e.error }` : '' }`));
    lifecycle.register('pre', [], () => Promise.resolve(), () => Promise.resolve(), { alreadyStarted: true });
    lifecycle.register('a', [], () => Promise.resolve(), () => Promise.resolve());
    lifecycle.register('bad', [], () => Promise.reject(new Error('boom')), () => Promise.resolve());
    lifecycle.register('needs-bad', ['bad'], () => Promise.resolve(), () => Promise.resolve());

    await lifecycle.startAll();

    expect(events).toEqual([
      'begin:pre,a,bad,needs-bad:pre',
      'a:start', 'a:ready',
      'bad:start', 'bad:failed:boom',
    ]);
    // Dependents of a failed service are no longer skipped: they wait for it (and retry with it).
    expect(lifecycle.serviceStatuses().find(s => s.name === 'needs-bad')?.status).toBe('waiting-on-dependency');
  });

  it('a throwing progress listener cannot break startup', async() => {
    const lifecycle = new ServiceLifecycleManager();

    lifecycle.on('startup:step', () => {
      throw new Error('listener bug');
    });
    lifecycle.register('a', [], () => Promise.resolve(), () => Promise.resolve());
    await lifecycle.startAll();
    expect(lifecycle.isStarted('a')).toBe(true);
  });
});

describe('StartupProgressHub', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('combines backend progress and lifecycle steps into coalesced snapshots', async() => {
    const sent: any[] = [];
    const hub = new StartupProgressHub(s => sent.push(s), () => 5_000);
    const lifecycle = new ServiceLifecycleManager();

    hub.attachLifecycle(lifecycle);
    hub.onBackendProgress({ current: 20, max: 100, description: 'Starting Backend' });
    hub.onBackendProgress({ current: 40, max: 100, description: 'Starting Backend' });
    jest.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ stage: 'boot', stepLabel: 'Preparing the virtual machine' });

    lifecycle.register('vault', [], () => Promise.resolve(), () => Promise.resolve());
    await lifecycle.startAll();
    hub.onBackendState('DISABLED');
    jest.advanceTimersByTime(100);
    expect(sent.at(-1)).toMatchObject({ ready: true, percent: 100 });
    expect(sent.at(-1).feed.map((f: any) => f.key)).toContain('service:vault');
    expect(hub.snapshot().ready).toBe(true);
  });
});
