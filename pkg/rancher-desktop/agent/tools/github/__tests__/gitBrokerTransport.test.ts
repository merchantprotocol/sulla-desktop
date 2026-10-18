import { scopeGitHubRepositoryContext } from '../gitBrokerTransport';

import type { ToolExecutionContext } from '../../executionContext';

describe('scopeGitHubRepositoryContext', () => {
  test('narrows account-only authority and rejects a conflicting repository', () => {
    const context = {
      v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'principal',
      agent_id: 'worker', pod_id: 'desktop-main', scopes: ['*'],
      iat: 1, exp: 2, jti: 'jti', request_id: 'request',
      credential_scope: { integration_id: 'github', account_id: 'active' },
    } satisfies ToolExecutionContext;

    expect(scopeGitHubRepositoryContext(context, 'active', 'owner/repo').credential_scope).toEqual({
      integration_id: 'github', account_id: 'active', repository: 'owner/repo',
    });
    expect(() => scopeGitHubRepositoryContext({
      ...context,
      credential_scope: { ...context.credential_scope, repository: 'other/repo' },
    }, 'active', 'owner/repo')).toThrow('signed credential scope');
  });
});
