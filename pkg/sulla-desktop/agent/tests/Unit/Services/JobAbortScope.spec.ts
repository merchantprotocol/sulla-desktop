// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { JobAbortScope } from '../../../app/Services/JobAbortScope';

describe('JobAbortScope', () => {
  it('aborts one task without touching its sibling', () => {
    // risk: lifecycle isolation — stopping one worker must not kill sibling work.
    const scope = new JobAbortScope();
    const first = scope.taskSignal(0);
    const second = scope.taskSignal(1);
    scope.abortTask(0);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it('cascades an explicit whole-job stop to every task', () => {
    // risk: lifecycle policy — an owner must retain an explicit whole-job kill switch.
    const scope = new JobAbortScope();
    const signals = [scope.taskSignal(0), scope.taskSignal(1)];
    scope.abortJob();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(scope.taskSignal(2).aborted).toBe(true);
  });
});
