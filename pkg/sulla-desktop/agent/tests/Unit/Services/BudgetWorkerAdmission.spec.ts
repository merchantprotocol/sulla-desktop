// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { BudgetWorkerAdmission, countBudgetWorkers } from '../../../services/BudgetWorkerAdmission';

describe('BudgetWorkerAdmission', () => {
  it('queues hidden work at the allowance and starts FIFO work when a slot frees', async() => {
    // risk: too many concurrent worker graphs consume machine resources
    const admission = new BudgetWorkerAdmission();
    let releaseFirst!: () => void;
    const state = async() => ({ allowance: 1, running: 0 });
    const first = admission.run(state, () => new Promise<void>(resolve => { releaseFirst = resolve; }));
    await Promise.resolve();
    let secondStarted = false;
    const second = admission.run(state, async() => { secondStarted = true; });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(admission.queued).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
    expect(admission.running).toBe(0);
  });

  it('recounts live work when an unrelated task settles and starts queued work FIFO', async() => {
    // risk: stale cross-job counts strand workers or exceed machine allowance
    const admission = new BudgetWorkerAdmission();
    let liveRunning = 0;
    const snapshot = async() => ({ allowance: 2, running: liveRunning });
    let finish!: () => void;
    const order: string[] = [];
    const first = admission.run(snapshot, () => new Promise<void>(resolve => { order.push('first'); finish = resolve; }));
    await Promise.resolve();
    const second = admission.run(snapshot, async() => { order.push('second'); });
    const third = admission.run(snapshot, async() => { order.push('third'); });
    liveRunning = 1;
    await admission.slotMayHaveFreed();
    expect(order).toEqual(['first']);
    liveRunning = 0;
    await admission.slotMayHaveFreed();
    expect(order).toEqual(['first', 'second']);
    finish();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('drains queued work when policy becomes unavailable (fail-open)', async() => {
    // risk: a deleted/invalid policy file must never deadlock hidden work
    const admission = new BudgetWorkerAdmission();
    let policyExists = true;
    const snapshot = async() => policyExists ? { allowance: 1, running: 0 } : { allowance: null, running: 0 };
    let finish!: () => void;
    const first = admission.run(snapshot, () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    let started = false;
    const second = admission.run(snapshot, async() => { started = true; });
    await Promise.resolve();
    expect(started).toBe(false);
    policyExists = false;
    await admission.slotMayHaveFreed();
    await second;
    expect(started).toBe(true);
    finish();
    await first;
  });

  it('does not count a running parent task that owns a child job', () => {
    // risk: manager/orchestrator tasks must not consume scarce worker slots
    expect(countBudgetWorkers([
      { jobId: 'manager', visibility: 'hidden', tasks: [{ status: 'running' }] },
      { jobId: 'worker', parentJobId: 'manager', parentTaskIndex: 0, visibility: 'hidden', tasks: [{ status: 'running' }] },
    ])).toBe(1);
  });

  it('admits a child at cap one while its own parent task is running', async() => {
    // risk: a manager holding the only slot can deadlock all of its workers
    const admission = new BudgetWorkerAdmission();
    const jobs = [
      { jobId: 'manager', visibility: 'hidden', tasks: [{ status: 'running' }] },
      { jobId: 'child-job', parentJobId: 'manager', parentTaskIndex: 0, visibility: 'hidden', tasks: [{ status: 'queued' }] },
    ];
    let started = false;
    await admission.run(async() => ({ allowance: 1, running: countBudgetWorkers(jobs) }), async() => { started = true; });
    expect(started).toBe(true);
  });

  it('keeps FIFO order when a parent exclusion opens the only slot', async() => {
    // risk: orchestrator exclusion must not let later workers jump the queue
    const admission = new BudgetWorkerAdmission();
    const jobs = [
      { jobId: 'manager', visibility: 'hidden', tasks: [{ status: 'running' }] },
      { jobId: 'child', parentJobId: 'manager', parentTaskIndex: 0, visibility: 'hidden', tasks: [{ status: 'queued' }] },
    ];
    const state = async() => ({ allowance: 1, running: countBudgetWorkers(jobs) });
    const order: string[] = [];
    await Promise.all([
      admission.run(state, async() => { order.push('first'); }),
      admission.run(state, async() => { order.push('second'); }),
    ]);
    expect(order).toEqual(['first', 'second']);
  });
});
