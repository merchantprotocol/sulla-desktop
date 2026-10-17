/**
 * MobileApiClient — thin HTTP layer for the Sulla Mobile backend on
 * Cloudflare Workers. The desktop agent can query the same endpoints the
 * phone hits — calls, leads, messages — so "show me my last call from
 * mobile" works without picking up the phone.
 *
 * The credential never enters this process. The local vault validates the
 * exact Sulla Cloud operation and injects the account token outbound.
 */

import type { ToolExecutionContext } from '../executionContext';
import { requireConfiguredCredentialBroker } from '../../../vault-broker';

const DEFAULT_API_BASE = 'https://sulla-workers.merchantprotocol.workers.dev';

export class MobileApiClient {
  async request<T>(ctx: ToolExecutionContext | undefined, method: string, pathSegment: string, body?: unknown): Promise<T> {
    if (!ctx?.agent_id || !ctx.pod_id) throw new Error('Sulla Cloud requires a verified caller identity');
    const { getIntegrationService } = await import('../../services/IntegrationService');
    const accountId = await getIntegrationService().getActiveAccountId('sulla-cloud');
    if (ctx.credential_scope?.integration_id !== 'sulla-cloud' || ctx.credential_scope.account_id !== accountId) {
      throw new Error('Sulla Cloud requires an exact signed credential scope from the trusted tool boundary');
    }
    const broker = requireConfiguredCredentialBroker();
    const result = await broker.execute(broker.requestFor(ctx, {
      operation: 'sulla-cloud.api',
      ref:       { integrationId: 'sulla-cloud', accountId },
      url:       `${ DEFAULT_API_BASE }${ pathSegment }`,
      method,
      headers:   { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body,
      injections: [{ field: 'api_token', target: 'header', name: 'authorization', scheme: 'Bearer' }],
      responseType: 'json',
    }));
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Mobile API ${ method } ${ pathSegment } returned HTTP ${ result.status }`);
    }
    return result.body as T;
  }
}

let singleton: MobileApiClient | null = null;

export function getMobileApiClient(): MobileApiClient {
  if (!singleton) singleton = new MobileApiClient();
  return singleton;
}
