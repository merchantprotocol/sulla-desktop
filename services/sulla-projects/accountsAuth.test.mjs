import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticateAccountsSession } from './dist/accountsAuth.js';

const config = { accountsUrl: 'http://accounts:3020', accountsServiceToken: 'synthetic-service-secret', jwtAudience: 'sulla-projects' };
const resolved = { subject: 'synthetic-user', authorityId: 'test-authority', issuer: 'https://synthetic.invalid', organizationId: 'org-a', audience: 'sulla-projects', roles: ['editor'], expiresAt: new Date(Date.now() + 60000).toISOString() };
test('Accounts authorization binds identity and audience and fails closed on revocation/outage', async () => {
  let calls = 0;
  const mock = async (url, request) => {
    calls++;
    assert.equal(url.pathname, '/v1/private/ui-sessions/resolve');
    assert.equal(request.headers['X-Sulla-Service-Id'], 'projects');
    assert.deepEqual(JSON.parse(request.body), { token: 'synthetic-ui-token', audience: 'sulla-projects', requiredRoles: [] });
    return Response.json(resolved);
  };
  const identity = await authenticateAccountsSession(config, 'Bearer synthetic-ui-token', mock);
  assert.equal(identity.tenantId, 'org-a'); assert.equal(identity.actor, 'synthetic-user'); assert.equal(identity.role, 'editor');
  await authenticateAccountsSession(config, 'Bearer synthetic-ui-token', mock);
  assert.equal(calls, 2, 'membership is resolved on every request');
  for (const changed of [{ audience: 'sulla-vault' }, { expiresAt: 'invalid' }, { expiresAt: '2000-01-01T00:00:00Z' }, { organizationId: '' }, { roles: [5] }]) {
    await assert.rejects(authenticateAccountsSession(config, 'Bearer synthetic-ui-token', async () => Response.json({ ...resolved, ...changed })), error => error.status === 401);
  }
  await assert.rejects(authenticateAccountsSession(config, 'Bearer synthetic-ui-token', async () => new Response('', { status: 403 })), error => error.status === 403);
  await assert.rejects(authenticateAccountsSession(config, 'Bearer synthetic-ui-token', async () => { throw new Error('offline'); }), error => error.status === 503);
  await assert.rejects(authenticateAccountsSession(config, undefined, mock), error => error.status === 401);
});
