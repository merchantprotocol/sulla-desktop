import { issueLocalBrokerContext, requireConfiguredCredentialBroker, usesContainerVaultAuthority } from '../../vault-broker';
import { getIntegrationService } from '../services/IntegrationService';

import type { BrokerInjection } from '../../vault-broker';
import type { BaseThreadState } from '../nodes/Graph';
import type { ToolExecutionContext } from '../tools/executionContext';

export interface ProviderRuntimeConfig {
  accountId: string;
  values:    Record<string, string>;
}

export async function loadProviderRuntimeConfig(providerId: string, accountId?: string): Promise<ProviderRuntimeConfig> {
  const integrationService = getIntegrationService();
  const resolvedAccountId = accountId ?? await integrationService.getActiveAccountId(providerId);
  const values = usesContainerVaultAuthority()
    ? await integrationService.getMetadataValues(providerId, resolvedAccountId)
    : await integrationService.getFormValues(providerId, resolvedAccountId);
  return {
    accountId: resolvedAccountId,
    values:    Object.fromEntries(values.map(value => [value.property, value.value])),
  };
}

/**
 * Issue an ephemeral broker context at the trusted graph boundary. The vault
 * sees the real graph identity and an exact provider/account scope; callers
 * cannot supply or widen either value through model options.
 */
export async function issueProviderExecutionContext(
  state: BaseThreadState,
  providerId: string,
  accountId: string,
): Promise<ToolExecutionContext> {
  const metadata = state.metadata as Record<string, any>;
  const agentId = String(metadata.agentId ?? metadata.wsChannel ?? '').trim();
  const threadId = String(metadata.threadId ?? '').trim();
  if (!agentId || !threadId) throw new Error('provider.inference requires trusted graph identity');

  return issueLocalBrokerContext({
    agentId,
    podId:              String(metadata.podId ?? `desktop:${ threadId }`),
    credentialScope:    { integration_id: providerId, account_id: accountId },
    threadId,
    jobId:              typeof metadata.jobId === 'string' ? metadata.jobId : undefined,
    workflowExecutionId: typeof metadata.workflowExecutionId === 'string' ? metadata.workflowExecutionId : undefined,
    orgId:              typeof metadata.orgId === 'string' ? metadata.orgId : undefined,
    signal:             metadata.options?.abort?.signal,
  });
}

/** Issue a scoped identity for trusted main-process model work outside a graph. */
export async function issueServiceProviderExecutionContext(
  serviceId: string,
  providerId: string,
  accountId: string,
  signal?: AbortSignal,
): Promise<ToolExecutionContext> {
  if (!serviceId.trim()) throw new Error('provider.inference requires a trusted service identity');
  return issueLocalBrokerContext({
    agentId: serviceId,
    podId:   'desktop-main',
    credentialScope: { integration_id: providerId, account_id: accountId },
    signal,
  });
}

interface ProviderFetchOptions {
  streaming:   boolean;
  injections?: BrokerInjection[];
}

export async function providerFetch(
  providerId: string,
  url: string,
  init: RequestInit,
  ctx: ToolExecutionContext | undefined,
  options: ProviderFetchOptions,
): Promise<Response> {
  if (!usesContainerVaultAuthority() || providerId === 'ollama') return fetch(url, init);
  if (!ctx) throw new Error('provider.inference requires a verified execution context');

  const scope = ctx.credential_scope;
  if (scope?.integration_id !== providerId || !scope.account_id) {
    throw new Error('provider.inference requires a signed credential scope for the selected provider account');
  }

  const headers = new Headers(init.headers);
  headers.delete('authorization');
  headers.delete('x-api-key');
  headers.delete('api-key');
  const rawBody = typeof init.body === 'string' ? init.body : undefined;
  let body: unknown = rawBody;
  if (rawBody) {
    try { body = JSON.parse(rawBody) } catch { /* provider body is text */ }
  }

  const broker = requireConfiguredCredentialBroker();
  const request = broker.requestFor(ctx, {
    operation:    'provider.inference',
    ref:          { integrationId: providerId, accountId: scope.account_id },
    url,
    method:       init.method ?? 'POST',
    headers:      Object.fromEntries(headers.entries()),
    body,
    injections:   options.injections ?? [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    responseType: options.streaming ? 'stream' : 'json',
  });
  if (options.streaming) return broker.executeStream(request, init.signal ?? undefined);

  const result = await broker.execute(request, init.signal ?? undefined);
  return new Response(result.body == null ? null : JSON.stringify(result.body), {
    status:  result.status,
    headers: result.headers,
  });
}
