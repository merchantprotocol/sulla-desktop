/**
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
/**
 * DeltaValidator is dependency-free, so it runs directly with the Node test runner:
 * `node --experimental-strip-types --test <this file>`. No install required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { DeltaValidator, MAX_CIPHERTEXT_CHARS } from '../conversationSync/deltaValidation.ts';

const validItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg-1',
  cursor: 1,
  role: 'assistant' as const,
  createdAt: '2026-11-18T17:00:00.000Z',
  ciphertext: 'AAAA',
  nonce: 'BBBB',
  keyVersion: 1,
  ...overrides,
});

// risk: data accuracy. A huge reply must not stop the rest of the chat from syncing.
test('an oversize body is skipped and its neighbours still go out in the batch', () => {
  const v = new DeltaValidator();
  const huge = 'A'.repeat(MAX_CIPHERTEXT_CHARS + 1);
  const batch = [
    validItem({ id: 'm-1', cursor: 1 }),
    validItem({ id: 'm-2', cursor: 2, ciphertext: huge }),
    validItem({ id: 'm-3', cursor: 3 }),
  ];
  const prepared = v.prepare(batch);
  assert.deepEqual(prepared.items.map(i => i.id), ['m-1', 'm-3']);
  assert.deepEqual(prepared.skipped, [{ id: 'm-2', reason: 'body_too_large_or_invalid' }]);
});

// risk: data accuracy. A body exactly at the Cloud cap is still sent.
test('a body exactly at the cap is accepted', () => {
  const v = new DeltaValidator();
  const atCap = 'A'.repeat(MAX_CIPHERTEXT_CHARS);
  assert.equal(v.check(validItem({ ciphertext: atCap })).ok, true);
});

// risk: data accuracy. Postgres-style timestamps must be normalised, or Cloud rejects the whole batch.
test('a Postgres "+00" createdAt is normalised to ISO 8601 UTC', () => {
  const v = new DeltaValidator();
  const verdict = v.check(validItem({ createdAt: '2026-11-18 17:00:00+00' }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.item.createdAt, '2026-11-18T17:00:00.000Z');
});

test('a naive createdAt is read as UTC', () => {
  const v = new DeltaValidator();
  const verdict = v.check(validItem({ createdAt: '2026-11-18 17:00:00' }));
  assert.equal(verdict.item.createdAt, '2026-11-18T17:00:00.000Z');
});

test('an unparseable createdAt is skipped with a reason, not sent', () => {
  const v = new DeltaValidator();
  assert.deepEqual(v.check(validItem({ createdAt: 'not a date' })), { ok: false, reason: 'invalid_created_at' });
});

// risk: data accuracy. Ids that Cloud would reject are skipped and named in the log.
test('an invalid message id is skipped and reported', () => {
  const v = new DeltaValidator();
  const prepared = v.prepare([validItem({ id: 'bad id with spaces', cursor: 4 }), validItem({ id: 'ok-5', cursor: 5 })]);
  assert.deepEqual(prepared.skipped, [{ id: 'bad id with spaces', reason: 'invalid_id' }]);
  assert.deepEqual(prepared.items.map(i => i.id), ['ok-5']);
});

test('a non-integer or zero cursor is skipped', () => {
  const v = new DeltaValidator();
  assert.equal(v.check(validItem({ cursor: 0 })).reason, 'invalid_cursor');
  assert.equal(v.check(validItem({ cursor: 1.5 })).reason, 'invalid_cursor');
});

test('metadata-only items (no body) pass through unchanged', () => {
  const v = new DeltaValidator();
  const meta = { id: 'm-9', cursor: 9, role: 'user' as const, createdAt: '2026-11-18T17:00:00.000Z' };
  const verdict = v.check(meta);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.item.ciphertext, undefined);
});

// risk: data accuracy. A driver returning Date objects must not cause every message to be skipped.
test('a Date createdAt is accepted and normalised', () => {
  const v = new DeltaValidator();
  const verdict = v.check(validItem({ createdAt: new Date('2026-11-18T17:00:00Z') as unknown as string }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.item.createdAt, '2026-11-18T17:00:00.000Z');
});
