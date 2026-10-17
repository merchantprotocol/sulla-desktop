import assert from 'node:assert/strict';
import test from 'node:test';

import { CALLER_OPERATION_POLICIES } from './callerPolicies';

test('caller operations bind exact hosts, paths, and credential fields', () => {
  const cloud = CALLER_OPERATION_POLICIES['sulla-cloud.api'];
  assert.deepEqual(cloud.hosts, ['sulla-workers.merchantprotocol.workers.dev']);
  assert.equal(cloud.pathPattern.test('/calls/id_1'), true);
  assert.equal(cloud.pathPattern.test('/admin'), false);
  assert.deepEqual(cloud.injections, [
    { field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' },
  ]);

  const transcription = CALLER_OPERATION_POLICIES['provider.transcription'];
  assert.deepEqual(transcription.hosts, ['api.x.ai']);
  assert.equal(transcription.pathPattern.test('/v1/stt'), true);
  assert.equal(transcription.pathPattern.test('/v1/tts'), false);
});
