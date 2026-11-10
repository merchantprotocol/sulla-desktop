// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { BrokerRedirectPolicy } from '../../../../../../services/sulla-vault/src/brokerRedirectPolicy';

describe('BrokerRedirectPolicy', () => {
  const policy = new BrokerRedirectPolicy();
  const context = (requestPath: string, location: string, operation = 'github.api') => ({
    operation, integrationId: 'github', requestUrl: new URL(`https://api.github.com${ requestPath }`), status: 302, location,
  });

  it('passes through only allow-listed GitHub Actions log redirects', () => {
    // risk: credential disclosure — only the signed redirect may leave the vault broker.
    expect(policy.allowsGitHubLogRedirect(context('/repos/acme/app/actions/jobs/123/logs', 'https://pipelines1.actions.githubusercontent.com/log?sig=secret'))).toBe(true);
    expect(policy.allowsGitHubLogRedirect(context('/repos/acme/app/actions/runs/123/attempts/2/logs', 'https://productionresultssa.blob.core.windows.net/log?sig=secret'))).toBe(true);
  });

  it('denies untrusted hosts and every non-log redirect', () => {
    // risk: SSRF — a non-log endpoint or attacker-controlled Location cannot redirect broker traffic.
    expect(policy.allowsGitHubLogRedirect(context('/repos/acme/app/actions/jobs/123/logs', 'https://attacker.example/log'))).toBe(false);
    expect(policy.allowsGitHubLogRedirect(context('/repos/acme/app/issues/123', 'https://pipelines.actions.githubusercontent.com/log'))).toBe(false);
    expect(policy.allowsGitHubLogRedirect(context('/repos/acme/app/actions/jobs/123/logs', 'https://pipelines.actions.githubusercontent.com/log', 'github.graphql'))).toBe(false);
  });
});
