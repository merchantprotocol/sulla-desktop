/**
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
/**
 * cloudCallBackoff is dependency-free, so it runs directly with the Node test runner:
 * `node --experimental-strip-types --test <this file>`. No install required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { CloudCallBackoff, CloudTransportError } from '../conversationSync/cloudCallBackoff.ts';

class RecordingLogger {
  warnings: string[] = [];
  infos: string[] = [];
  warn(message: unknown) { this.warnings.push(String(message)) }
  log(message: unknown) { this.infos.push(String(message)) }
}

function setup() {
  const clock = { at: 1_000, now() { return this.at } };
  const logger = new RecordingLogger();
  const backoff = new CloudCallBackoff('Cloud results pull', logger, clock, 30_000, 120_000);
  return { clock, logger, backoff };
}

test('a broker failure blocks further attempts until its backoff window passes', () => {
  // risk: availability — a failing broker must not be hit again for every linked chat in the same pass
  const { clock, backoff } = setup();
  assert.equal(backoff.canAttempt(), true);
  assert.equal(backoff.failed('internal_error'), 30_000);
  assert.equal(backoff.canAttempt(), false);
  clock.at += 29_999;
  assert.equal(backoff.canAttempt(), false);
  clock.at += 1;
  assert.equal(backoff.canAttempt(), true);
});

test('repeated failures back off exponentially and stay bounded by the cap', () => {
  // risk: availability — retries must be bounded, never a tight loop and never an unbounded wait
  const { backoff } = setup();
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(() => backoff.failed('upstream_timeout')),
    [30_000, 60_000, 120_000, 120_000, 120_000],
  );
  assert.equal(backoff.consecutiveFailures, 5);
});

test('a failure streak logs one line, a new error code logs again, and recovery logs once', () => {
  // risk: log flood — 374 identical stack traces per session hid every other error
  const { logger, backoff } = setup();
  for (let i = 0; i < 50; i++) backoff.failed('internal_error');
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /Cloud results pull unavailable \(internal_error\)/);
  backoff.failed('upstream_timeout');
  assert.equal(logger.warnings.length, 2);
  assert.match(logger.warnings[1], /upstream_timeout.*49 identical failure/);
  backoff.succeeded();
  assert.deepEqual(logger.infos, ['[ConversationSync] Cloud results pull recovered after 51 failed attempt(s)']);
});

test('success resets the streak so the next failure starts from the base delay', () => {
  // risk: availability — a recovered broker must not inherit a long stale backoff
  const { logger, backoff } = setup();
  backoff.failed('internal_error');
  backoff.failed('internal_error');
  backoff.succeeded();
  assert.equal(backoff.canAttempt(), true);
  assert.equal(backoff.failed('internal_error'), 30_000);
  assert.equal(logger.warnings.length, 2);
  backoff.succeeded();
  backoff.succeeded();
  assert.equal(logger.infos.length, 2);
});

test('transport errors keep the vault broker code and never echo unsafe codes', () => {
  // risk: diagnostics — the code must identify the broker failure without leaking arbitrary text
  const broker = Object.assign(new Error('Broker request timed out'), { name: 'VaultBrokerError', code: 'upstream_timeout' });
  assert.equal(new CloudTransportError(broker).code, 'upstream_timeout');
  assert.equal(new CloudTransportError(broker).message, 'Broker request timed out');
  const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal(new CloudTransportError(abort).code, 'TimeoutError');
  assert.equal(new CloudTransportError(Object.assign(new Error('x'), { code: 'Bearer abc def' })).code, 'transport_error');
  assert.equal(new CloudTransportError('plain').code, 'transport_error');
});
