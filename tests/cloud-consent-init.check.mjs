// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// Run: node --experimental-strip-types --test tests/cloud-consent-init.check.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planConsentInit } from '../pkg/sulla-desktop/main/cloud/cloudConsentInit.ts';

const KEYS = ['enabled','workflows','skills','customAgents','recipes','useCases','liveAgents','usage','memory','conversations','files','vault','remoteAccess'];

test('new install: every category starts off', () => {
  const plan = planConsentInit(KEYS, {}, '0');
  assert.deepEqual(Object.keys(plan).sort(), [...KEYS].sort());
  assert.ok(Object.values(plan).every(v => v === false));
});

test('existing V2 user (default-on era): every explicit value is left unchanged', () => {
  const current = Object.fromEntries(KEYS.map(k => [k, true]));
  assert.deepEqual(planConsentInit(KEYS, current, '42'), {});
});

test('existing user with mixed and false values: nothing is touched', () => {
  const current = Object.fromEntries(KEYS.map((k, i) => [k, i % 2 === 0 ? 'true' : false]));
  current.vault = 'false';
  assert.deepEqual(planConsentInit(KEYS, current, '0'), {});
});

test('partially initialised user: only missing keys are filled, and filled off', () => {
  const current = { enabled: true, memory: true, conversations: false };
  const plan = planConsentInit(KEYS, current, '0');
  assert.equal('enabled' in plan || 'memory' in plan || 'conversations' in plan, false);
  assert.ok(Object.values(plan).every(v => v === false));
});

test('pre-V2 legacy chat sync (cursor only) keeps chat sync on and nothing else', () => {
  const plan = planConsentInit(KEYS, {}, '17');
  assert.equal(plan.conversations, true);
  assert.equal(plan.enabled, true);
  for (const k of KEYS.filter(k => k !== 'conversations' && k !== 'enabled')) assert.equal(plan[k], false, k);
});
