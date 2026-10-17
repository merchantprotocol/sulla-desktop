import { Octokit } from '@octokit/rest';

import {
  issueLocalBrokerContext,
  requireConfiguredCredentialBroker,
  usesContainerVaultAuthority,
} from '../../../vault-broker';
import { getIntegrationService } from '../../services/IntegrationService';

import type { ToolExecutionContext } from '../executionContext';

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers);
  normalized.delete('authorization');
  return Object.fromEntries(normalized.entries());
}

/** Octokit transport whose final outbound request and auth injection live in the vault. */
export async function createGitHubOctokit(ctx: ToolExecutionContext | undefined): Promise<Octokit> {
  const accountId = await getIntegrationService().getActiveAccountId('github');
  if (!usesContainerVaultAuthority()) {
    const token = await getIntegrationService().getIntegrationValue('github', 'token', accountId);
    if (!token?.value) throw new Error('GitHub is not connected in the vault');
    return new Octokit({ auth: token.value });
  }
  if (!ctx) throw new Error('GitHub vault routing requires a verified tool execution context');
  const broker = requireConfiguredCredentialBroker();
  if (ctx.credential_scope?.integration_id !== 'github' || ctx.credential_scope.account_id !== accountId) {
    throw new Error('GitHub vault routing requires a signed credential scope for the active account');
  }

  return new Octokit({
    request: {
      fetch: async(url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const destination = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
        const method = init?.method ?? (url instanceof Request ? url.method : 'GET');
        const headers = headersRecord(init?.headers ?? (url instanceof Request ? url.headers : undefined));
        const rawBody = init?.body;
        let body: unknown;
        if (typeof rawBody === 'string' && rawBody) {
          try { body = JSON.parse(rawBody) } catch { body = rawBody }
        }
        const request = broker.requestFor(ctx, {
          operation:    new URL(destination).pathname === '/graphql' ? 'github.graphql' : 'github.api',
          ref:          { integrationId: 'github', accountId },
          url:          destination,
          method,
          headers,
          body,
          injections:   [{ field: 'token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
          responseType: 'json',
        });
        const result = await broker.execute(request, init?.signal ?? undefined);
        return new Response(result.body == null ? null : JSON.stringify(result.body), {
          status:  result.status,
          headers: result.headers,
        });
      },
    },
  });
}

/** Issue a trusted Desktop service context for non-tool GitHub consumers. */
export async function createGitHubServiceOctokit(agentId: string): Promise<Octokit> {
  if (!usesContainerVaultAuthority()) return createGitHubOctokit(undefined);
  const accountId = await getIntegrationService().getActiveAccountId('github');
  const ctx = await issueLocalBrokerContext({
    agentId,
    podId:          'desktop-main',
    credentialScope: { integration_id: 'github', account_id: accountId },
  });
  return createGitHubOctokit(ctx);
}
