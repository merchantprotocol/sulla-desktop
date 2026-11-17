// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { BudgetWorkerAdmission } from '../../../services/BudgetWorkerAdmission';

describe('BudgetWorkerAdmission', () => {
  it('queues hidden work at the allowance and starts FIFO work when a slot frees', async() => {
    // risk: too many concurrent worker graphs consume machine resources
    const admission = new BudgetWorkerAdmission();
    let releaseFirst!: () => void;
    const first = admission.run(1, () => new Promise<void>(resolve => { releaseFirst = resolve; }));
    await Promise.resolve();
    let secondStarted = false;
    const second = admission.run(1, async() => { secondStarted = true; });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(admission.queued).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
    expect(admission.running).toBe(0);
  });
});
