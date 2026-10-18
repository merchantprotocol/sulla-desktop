import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleGrantIssueRequest } from './scheduleGrantRequest.js';

test('schedule grant issuance uses the public bearer contract without serializing the bearer', () => {
  const bearerToken = 'private-user-bearer-value';
  const request = scheduleGrantIssueRequest({
    authorityId:     'f72a606e-1da4-4fc4-8ac8-18c49bb758ee',
    organizationId:  'f30a84fb-8b66-4948-b927-753a57be5d4b',
    audience:        'sulla-workflows',
    serviceId:       'workflows',
    workflowId:      'workflow-1',
    scheduleNodeId:  'schedule-1',
    requiredRoles:   ['member'],
    expiresAt:       '2026-12-31T00:00:00.000Z',
    replaceGrantId:  '72ae38c5-64de-49d2-9104-20def21d0885',
  }, bearerToken, {
    'Content-Type':          'application/json',
    'X-Sulla-Service-Id':    'workflows',
    'X-Sulla-Service-Token': 'private-service-token',
  });

  assert.equal(request.path, '/v1/authority/schedule-grants');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(request.init.headers, {
    'Content-Type':          'application/json',
    'X-Sulla-Service-Id':    'workflows',
    'X-Sulla-Service-Token': 'private-service-token',
    Authorization:           `Bearer ${ bearerToken }`,
  });

  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.bearerToken, undefined);
  assert.deepEqual(body, {
    authorityId:    'f72a606e-1da4-4fc4-8ac8-18c49bb758ee',
    organizationId: 'f30a84fb-8b66-4948-b927-753a57be5d4b',
    audience:       'sulla-workflows',
    serviceId:      'workflows',
    workflowId:     'workflow-1',
    scheduleNodeId: 'schedule-1',
    requiredRoles:  ['member'],
    expiresAt:      '2026-12-31T00:00:00.000Z',
    replaceGrantId: '72ae38c5-64de-49d2-9104-20def21d0885',
  });
  assert.equal(JSON.stringify(body).includes(bearerToken), false);
  assert.equal(JSON.stringify(request.log).includes(bearerToken), false);
  assert.deepEqual(request.log, {
    operation:      'issue_schedule_grant',
    path:           '/v1/authority/schedule-grants',
    workflowId:     'workflow-1',
    scheduleNodeId: 'schedule-1',
    replacement:    true,
  });
});
