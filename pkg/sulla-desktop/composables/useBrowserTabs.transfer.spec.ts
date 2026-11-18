// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { applyTransferAdoption } from './useBrowserTabs';

describe('early tab transfer adoption', () => {
  it('applies an adopted tab before acknowledging transfer readiness', () => {
    // risk: dropped tab during tear-off into a newly-created window
    const tabs: Array<{ id: string }> = [];
    let acknowledged = false;
    applyTransferAdoption(tab => tabs.push(tab), { id: 'tab-new' }, () => { acknowledged = true; });
    expect(tabs).toEqual([{ id: 'tab-new' }]);
    expect(acknowledged).toBe(true);
  });
});
