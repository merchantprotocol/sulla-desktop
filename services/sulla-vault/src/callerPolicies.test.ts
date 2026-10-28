// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CALLER_OPERATION_POLICIES } from './callerPolicies.js';

test('caller operations bind exact hosts, paths, and credential fields', () => {
  const cloud = CALLER_OPERATION_POLICIES['sulla-cloud.api'];
  assert.deepEqual(cloud.hosts, ['sulla-workers.merchantprotocol.workers.dev']);
  assert.deepEqual(cloud.methods, ['GET', 'POST']);
  assert.equal(cloud.pathPattern.test('/calls/id_1'), true);
  assert.equal(cloud.pathPattern.test('/shares/id_1'), false);
  assert.equal(cloud.pathPattern.test('/admin'), false);
  assert.deepEqual(cloud.injections, [
    { field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
  ]);

  const shares = CALLER_OPERATION_POLICIES['sulla-cloud.shares'];
  assert.deepEqual(shares.methods, ['GET', 'POST', 'PATCH', 'DELETE', 'PUT']);
  assert.equal(shares.pathPattern.test('/shares/id_1/content'), true);
  assert.equal(shares.pathPattern.test('/calls/id_1'), false);

  const transcription = CALLER_OPERATION_POLICIES['provider.transcription'];
  assert.deepEqual(transcription.hosts, ['api.x.ai']);
  assert.equal(transcription.pathPattern.test('/v1/stt'), true);
  assert.equal(transcription.pathPattern.test('/v1/tts'), false);
});
