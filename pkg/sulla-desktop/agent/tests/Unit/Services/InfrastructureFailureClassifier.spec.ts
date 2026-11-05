// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import {
  InfrastructureFailureClassifier,
  InfrastructureFailureResultPresenter,
  RunningTaskInfrastructureFailureResolver,
} from '@pkg/agent/services/InfrastructureFailureClassifier';

class FakeRunningWorker {
  constructor(private readonly resolver: RunningTaskInfrastructureFailureResolver) {}
  async run(): Promise<ReturnType<RunningTaskInfrastructureFailureResolver['resolve']>> {
    try {
      throw new Error('Agent container exited 1: yarn: ENOSPC: no space left on device, write');
    } catch (error) {
      return this.resolver.resolve({ error, lastLogLines: 'fatal: git write error: No space left on device' });
    }
  }
}

describe('InfrastructureFailureClassifier', () => {
  const classifier = new InfrastructureFailureClassifier();
  const diskFullCases: Array<[unknown, string | undefined, string | undefined]> = [
    [{ code: 'ENOSPC', message: 'write failed' }, undefined, undefined],
    [Object.assign(new Error('write failed'), { errno: -28 }), undefined, undefined],
    [new Error('No space left on device'), undefined, undefined],
    [undefined, 'docker: failed: no space left on device', undefined],
    [undefined, undefined, 'fatal: git write error: No space left on device'],
  ];

  it.each(diskFullCases)('classifies disk exhaustion from errors, exits, and log tails', (error, exitOutput, lastLogLines) => {
    // risk: machine failure is blamed on worker behavior
    expect(classifier.classify({ error, exitOutput, lastLogLines })).toMatchObject({
      failureType: 'infrastructure', reason: 'infrastructure: disk full',
    });
  });

  it('does not classify an ordinary worker exception as infrastructure', () => {
    // risk: a work defect triggers machine remediation instead of a corrected brief
    expect(classifier.classify({ error: new Error('assertion failed') })).toBeUndefined();
  });

  it('presents the typed failure in the parent result shape with the reason first', () => {
    // risk: the parent must parse prose and cannot distinguish machine failure
    const failure = classifier.classify({ error: Object.assign(new Error('write'), { code: 'ENOSPC' }) })!;
    expect(new InfrastructureFailureResultPresenter().present(failure)).toEqual({
      status: 'failed', failureType: 'infrastructure', summary: 'infrastructure: disk full',
    });
  });

  it('turns a running worker non-zero exit into a typed parent failure end-to-end', async() => {
    // risk: a worker losing the disk mid-task is blamed on the worker and its parent cannot retry safely
    const runner = new FakeRunningWorker(new RunningTaskInfrastructureFailureResolver(
      classifier, new InfrastructureFailureResultPresenter(),
    ));
    await expect(runner.run()).resolves.toEqual({
      status: 'failed', failureType: 'infrastructure', summary: 'infrastructure: disk full',
    });
  });
});
