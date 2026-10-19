import assert from 'node:assert/strict';
import test from 'node:test';

import { assertOrganizationUserMutation, organizationUsers } from './consoleAuthorization.js';

test('organization user directory resolves only subjects with membership in the selected organization', async() => {
  const lookedUp: string[] = [];
  const users = await organizationUsers([
    { subject: 'org-a-user', roles: ['member'] },
  ], async subject => {
    lookedUp.push(subject);
    return { id: subject, username: subject, enabled: true };
  });
  assert.deepEqual(lookedUp, ['org-a-user']);
  assert.equal(users[0].membership.subject, 'org-a-user');
});

test('organization administrator cannot mutate global identity status or credentials', () => {
  assert.throws(() => assertOrganizationUserMutation({ enabled: false }), /cannot change global/);
  assert.throws(() => assertOrganizationUserMutation({ temporaryPassword: 'synthetic-password' }), /cannot change global/);
  assert.doesNotThrow(() => assertOrganizationUserMutation({ roles: ['editor'], groups: [] }));
});
