// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { ParkedContainerLifecycle } from '../../../../services/ParkedContainerLifecycle';

describe('ParkedContainerLifecycle', () => {
  it('releases a container for a long park and resumes through a fresh lifecycle', async() => {
    // risk: the 30-minute container idle reap kills a worker parked for 45 minutes
    const first = { execute: (action: any) => action(), close: vi.fn(async() => ({})) } as any;
    const second = { execute: (action: any) => action(), close: vi.fn(async() => ({})) } as any;
    const factory = vi.fn(async() => second);
    const lifecycle = new ParkedContainerLifecycle(first, factory);
    await lifecycle.park();
    expect(first.close).toHaveBeenCalledWith('delegated-task-parked', 'ParkedContainerLifecycle.park');
    await lifecycle.resume();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(lifecycle.execute(() => 'same-thread-turn')).toBe('same-thread-turn');
  });
});
