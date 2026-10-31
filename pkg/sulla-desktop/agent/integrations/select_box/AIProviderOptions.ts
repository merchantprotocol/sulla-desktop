// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SelectBoxProvider, type SelectBoxContext, type SelectOption } from './SelectBoxProvider';

class StaticOptions extends SelectBoxProvider {
  constructor(readonly id: string, private readonly options: SelectOption[]) { super(); }

  async getOptions(_context: SelectBoxContext): Promise<SelectOption[]> {
    return this.options;
  }
}

export const kimiRegions = new StaticOptions('kimi_regions', [
  { value: 'international', label: 'International' },
  { value: 'china', label: 'China' },
]);

export const alibabaPlans = new StaticOptions('alibaba_plans', [
  { value: 'payg', label: 'Pay-as-you-go' },
  { value: 'coding', label: 'Coding Plan' },
]);

export const alibabaRegions = new StaticOptions('alibaba_regions', [
  { value: 'intl', label: 'International' },
  { value: 'us', label: 'US' },
  { value: 'cn', label: 'China' },
]);
