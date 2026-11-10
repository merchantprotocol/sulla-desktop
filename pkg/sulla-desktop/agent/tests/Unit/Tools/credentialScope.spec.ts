// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { scopeToolExecutionContextToAccount } from '../../../tools/credentialScope';
import { getIntegrationService } from '../../../services/IntegrationService';
import type { ToolExecutionContext } from '../../../tools/executionContext';

vi.mock('../../../services/IntegrationService', () => ({
  getIntegrationService: vi.fn(),
}));
vi.mock('../../../../vault-broker', () => ({
  requireConfiguredCredentialBroker: vi.fn(),
}));

const SLACK_ACCOUNTS = [
  { account_id: 'team-a' },
  { account_id: 'team-b' },
  { account_id: 'team-off', credentialRequired: false },
];

function baseContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    agent_id:  'agent-1',
    pod_id:    'pod-1',
    thread_id: 'thread-1',
    ...overrides,
  } as ToolExecutionContext;
}

describe('scopeToolExecutionContextToAccount', () => {
  beforeEach(() => {
    vi.mocked(getIntegrationService).mockReturnValue({
      getAccounts: vi.fn(async() => SLACK_ACCOUNTS),
    } as any);
  });

  it('scopes the context to the explicitly requested account', async() => {
    // risk: tenant isolation — the signed scope must name the account the call targets
    const scoped = await scopeToolExecutionContextToAccount(baseContext(), 'slack', 'team-b');

    expect(scoped.credential_scope).toEqual({ integration_id: 'slack', account_id: 'team-b' });
  });

  it('refuses an account that is not configured for the integration', async() => {
    // risk: permissions — a call must never be signed for an account the user did not connect
    await expect(scopeToolExecutionContextToAccount(baseContext(), 'slack', 'team-z'))
      .rejects.toThrow('Unknown slack account: team-z');
  });

  it('refuses an account whose credentials are not required', async() => {
    // risk: permissions — accounts without credentials must not receive a signed scope
    await expect(scopeToolExecutionContextToAccount(baseContext(), 'slack', 'team-off'))
      .rejects.toThrow('Unknown slack account: team-off');
  });

  it('refuses an existing scope that names a different account', async() => {
    // risk: tenant isolation — a verified scope for team-a must never be re-pointed at team-b
    const ctx = baseContext({ credential_scope: { integration_id: 'slack', account_id: 'team-a' } } as Partial<ToolExecutionContext>);

    await expect(scopeToolExecutionContextToAccount(ctx, 'slack', 'team-b'))
      .rejects.toThrow('Verified credential scope does not match the selected tool target');
  });

  it('refuses an existing scope that names a different integration', async() => {
    // risk: permissions — a GitHub-scoped context must not be reused to call Slack
    const ctx = baseContext({ credential_scope: { integration_id: 'github', account_id: 'team-a' } } as Partial<ToolExecutionContext>);

    await expect(scopeToolExecutionContextToAccount(ctx, 'slack', 'team-a'))
      .rejects.toThrow('Verified credential scope does not match the selected tool target');
  });

  it('accepts an existing scope that already names the same account', async() => {
    // risk: false refusal — a matching verified scope should pass through
    const ctx = baseContext({ credential_scope: { integration_id: 'slack', account_id: 'team-a' } } as Partial<ToolExecutionContext>);

    const scoped = await scopeToolExecutionContextToAccount(ctx, 'slack', 'team-a');

    expect(scoped.credential_scope).toEqual({ integration_id: 'slack', account_id: 'team-a' });
  });
});
