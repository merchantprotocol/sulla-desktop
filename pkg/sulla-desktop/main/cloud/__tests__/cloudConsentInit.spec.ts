/**
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
/**
 * cloudConsentInit is dependency-free by design (see its own doc comment), so it runs
 * directly with the Node test runner: `node --experimental-strip-types --test <this file>`.
 * No jest/vitest config and no npm install required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planConsentInit, recommendedConsentPatch } from '../cloudConsentInit.ts';

test('recommendedConsentPatch opts in to exactly the given kinds, plus enabled', () => {
  // risk: data correctness — this feeds the "Turn on recommended" button in CloudConnectionCard
  assert.deepEqual(
    recommendedConsentPatch(['usage', 'memory', 'conversations', 'files']),
    { enabled: true, usage: true, memory: true, conversations: true, files: true },
  );
  assert.deepEqual(recommendedConsentPatch([]), { enabled: true });
});

test('planConsentInit defaults every missing key to off for a fresh install', () => {
  // risk: data correctness — a new install must not silently start uploading anything
  const plan = planConsentInit(['enabled', 'usage', 'memory'], {}, '0');
  assert.deepEqual(plan, { enabled: false, usage: false, memory: false });
});

test('planConsentInit never overrides a key that already has an explicit value', () => {
  // risk: data correctness — existing users keep their settings, including explicit false
  const plan = planConsentInit(
    ['enabled', 'usage', 'memory'],
    { memory: false, usage: true },
    '0',
  );
  assert.deepEqual(plan, { enabled: false });
});

test('planConsentInit ignores a key that is no longer in the migration list', () => {
  // risk: data correctness — removed marketplace categories (workflows, skills, liveAgents, ...)
  // must never be planned or written once they are no longer passed as a known key
  const plan = planConsentInit(['enabled', 'usage'], { workflows: true, liveAgents: true }, '0');
  assert.deepEqual(plan, { enabled: false, usage: false });
  assert.ok(!('workflows' in plan));
  assert.ok(!('liveAgents' in plan));
});

test('planConsentInit keeps legacy pre-V2 chat sync on when a real cursor exists', () => {
  // risk: data correctness — pre-V2 installs whose only consent signal was the legacy
  // chat cursor must keep chat sync on, matching the V2 migration behavior
  const plan = planConsentInit(['enabled', 'conversations', 'files'], {}, '42');
  assert.deepEqual(plan, { enabled: true, conversations: true, files: false });
});

test('planConsentInit treats a zero or non-numeric legacy cursor as "no legacy signal"', () => {
  const zero = planConsentInit(['enabled', 'conversations'], {}, '0');
  assert.deepEqual(zero, { enabled: false, conversations: false });
  const notANumber = planConsentInit(['enabled', 'conversations'], {}, 'nope');
  assert.deepEqual(notANumber, { enabled: false, conversations: false });
});
