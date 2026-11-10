// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { StrandedManagerLifecycle, type ApplicationQuitEvents } from '../../../app/Services/StrandedManagerLifecycle';

class FakeScheduler {
  starts = 0;
  stops = 0;
  start(): void { this.starts++ }
  stop(): void { this.stops++ }
}

class FakeApplication implements ApplicationQuitEvents {
  private readonly listeners = new Map<string, () => void>();
  once(event: 'before-quit' | 'will-quit', listener: () => void): void { this.listeners.set(event, listener) }
  emit(event: 'before-quit' | 'will-quit'): void { this.listeners.get(event)?.(); this.listeners.delete(event) }
}

describe('StrandedManagerLifecycle', () => {
  it('starts the scheduler once and deterministically stops it during application quit', () => {
    // risk: stranded reconciliation is dormant in production or leaks its interval during shutdown
    const scheduler = new FakeScheduler();
    const app = new FakeApplication();
    const lifecycle = new StrandedManagerLifecycle(scheduler, app);

    lifecycle.start();
    lifecycle.start();
    expect(scheduler.starts).toBe(1);

    app.emit('before-quit');
    app.emit('will-quit');
    expect(scheduler.stops).toBe(1);
  });
});
