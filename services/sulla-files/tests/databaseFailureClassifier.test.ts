// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { DatabaseFailureClassifier, RetryableDatabaseError } from '../src/FilesTransaction.js';

describe('DatabaseFailureClassifier', () => {
  const classifier = new DatabaseFailureClassifier();

  // risk: data loss / EIO — every way the iMac run lost a connection must become a retryable 503.
  it('treats lost or unobtainable connections as retryable', () => {
    for (const error of [
      Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' }),
      Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
      new Error('Connection terminated unexpectedly'),
      new Error('Client has encountered a connection error and is not queryable'),
      new Error('timeout exceeded when trying to connect'),
      new RetryableDatabaseError(false),
    ]) expect(classifier.isConnectionLoss(error), String(error.message)).toBe(true);
  });

  // risk: duplicate writes — real statement failures (conflicts, constraint errors) must not be retried as transient.
  it('leaves statement errors alone', () => {
    for (const error of [
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
      Object.assign(new Error('null value in column'), { code: '23502' }),
      Object.assign(new Error('could not serialize access'), { code: '40001' }),
      new Error('A file already occupies docs/a.md'),
      undefined,
    ]) expect(classifier.isConnectionLoss(error)).toBe(false);
  });
});
