// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { MarketplacePurchasePolicy } from './MarketplacePurchasePolicy';

describe('MarketplacePurchasePolicy', () => {
  const policy = new MarketplacePurchasePolicy();

  it('offers checkout and blocks installation until Workers confirms paid ownership (risk: money)', () => {
    expect(policy.shouldBuy({ is_paid: true, owned: false })).toBe(true);
    expect(policy.canInstall({ is_paid: true, owned: false })).toBe(false);
    expect(policy.shouldBuy({ is_paid: true, owned: true })).toBe(false);
    expect(policy.canInstall({ is_paid: true, owned: true })).toBe(true);
  });

  it('preserves install behavior for free and legacy listings (risk: access)', () => {
    expect(policy.shouldBuy({ is_paid: false, owned: false })).toBe(false);
    expect(policy.canInstall({ is_paid: false, owned: false })).toBe(true);
    expect(policy.canInstall({ owned: false })).toBe(true);
  });
});
