// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentJobLifecycleService } from '../../../services/AgentJobLifecycleService';

describe('AgentJobLifecycleService pending wake ownership', () => {
  it('consumes a queued wake exactly once', async() => {
    // risk: duplicate manager turn after child completion
    const service = new AgentJobLifecycleService({ openChildrenForThread: async() => 1 }, vi.fn(), vi.fn());
    expect(service.wake('thread')).toBe(false);
    await expect(service.waitForWake('thread')).resolves.toBeUndefined();
    const abort = new AbortController();
    const waiting = service.waitForWake('thread', abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
