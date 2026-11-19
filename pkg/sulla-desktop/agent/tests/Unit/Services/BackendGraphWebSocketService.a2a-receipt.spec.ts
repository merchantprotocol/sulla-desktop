// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { mapInboxReceiptToA2aStatus } from '../../../services/BackendGraphWebSocketService';

describe('A2A inbox receipt status mapping', () => {
  it('maps accepted delivery to delivered', () => { // risk: false delivery state
    expect(mapInboxReceiptToA2aStatus('accepted')).toEqual({ status: 'delivered' });
  });

  it('maps a deferred/busy receiver to delivered with queued reason', () => { // risk: sender believes a queued message was lost
    expect(mapInboxReceiptToA2aStatus('deferred')).toEqual({ status: 'delivered', reason: 'queued' });
    expect(mapInboxReceiptToA2aStatus('queued')).toEqual({ status: 'delivered', reason: 'queued' });
  });

  it('maps a failed receipt to failed with a reason', () => { // risk: failed peer message presented as sent
    expect(mapInboxReceiptToA2aStatus('failed')).toEqual({ status: 'failed', reason: 'delivery failed' });
  });
});
