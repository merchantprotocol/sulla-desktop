// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { DelegatedWakeSettlementPolicy } from '../../../services/DelegatedWakeSettlementPolicy';

describe('DelegatedWakeSettlementPolicy', () => {
  const policy = new DelegatedWakeSettlementPolicy();

  it('re-parks an empty completion wake when one sibling is still live', () => {
    // risk: lost delegated work
    // A settled sibling's result woke the manager, but another worker remains active.
    expect(policy.shouldPark({ liveChildren: 1, pendingWait: false, consecutiveEmptyWakes: 1 })).toBe(true);
  });

  it('fails after the third consecutive empty wake even while children remain live', () => {
    // risk: indefinitely parked manager after repeated no-output wakes
    expect(policy.shouldPark({ liveChildren: 1, pendingWait: false, consecutiveEmptyWakes: 2 })).toBe(true);
    expect(policy.shouldPark({ liveChildren: 1, pendingWait: false, consecutiveEmptyWakes: 3 })).toBe(false);
  });

  it('fails an empty wake with no live child or pending wait', () => {
    // risk: lost delegated work
    expect(policy.shouldPark({ liveChildren: 0, pendingWait: false, consecutiveEmptyWakes: 0 })).toBe(false);
  });
});
