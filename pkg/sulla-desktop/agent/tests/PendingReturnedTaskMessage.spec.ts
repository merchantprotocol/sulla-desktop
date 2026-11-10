// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { PendingReturnedTaskMessage } from '../app/Services/PendingReturnedTaskMessage';

describe('PendingReturnedTaskMessage', () => {
  it('replaces the generic refusal with a returned-time inbox instruction only while output is unread', () => {
    // risk: orchestrator follow-ups must not be silently refused while the completion is pending.
    const message = new PendingReturnedTaskMessage();
    expect(message.forTask({
      status: 'completed', returnedAt: 1_800_000_000_000,
      completion: { label: 'worker', status: 'completed', output: 'done', threadId: 'child' },
    } as any)).toBe('Task returned at 2027-01-15T08:00:00.000Z; its result is pending in your inbox — read it first.');
    expect(message.forTask({
      status: 'completed', returnedAt: 1_800_000_000_000, completionDeliveredAt: 1_800_000_000_100,
      completion: { label: 'worker', status: 'completed', output: 'done', threadId: 'child' },
    } as any)).toBeUndefined();
  });
});
