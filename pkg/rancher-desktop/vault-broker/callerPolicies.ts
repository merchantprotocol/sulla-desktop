import type { BrokerExecuteRequest } from './index';

export const ENTERPRISE_GATEWAY_INTEGRATION_ID = 'enterprise_gateway';
export const ENTERPRISE_GATEWAY_RELAY_OPERATION = 'enterprise.gateway' as const;
export const ENTERPRISE_GATEWAY_HTTP_OPERATION = 'enterprise.gateway.http' as const;

export function enterpriseGatewayCredentialScope(accountId: string) {
  return { integration_id: ENTERPRISE_GATEWAY_INTEGRATION_ID, account_id: accountId } as const;
}

export function enterpriseGatewayHttpRequest(input: {
  accountId:  string;
  gatewayUrl: string;
  method:     'POST' | 'DELETE';
  sessionId?: string;
  body?:      unknown;
}): Omit<BrokerExecuteRequest, 'claims'> {
  const gatewayUrl = new URL(input.gatewayUrl);
  if (gatewayUrl.protocol !== 'https:' || gatewayUrl.username || gatewayUrl.password ||
      gatewayUrl.search || gatewayUrl.hash || !gatewayUrl.hostname ||
      (gatewayUrl.pathname !== '/' && gatewayUrl.pathname !== '')) {
    throw new Error('Enterprise gateway URL must be a credential-free HTTPS origin');
  }
  if (input.method === 'DELETE' && !input.sessionId) {
    throw new Error('Enterprise gateway session deletion requires a session identifier');
  }
  const origin = gatewayUrl.origin;
  const path = input.method === 'POST'
    ? '/api/desktop/sessions'
    : `/api/desktop/sessions/${ encodeURIComponent(input.sessionId ?? '') }`;
  return {
    operation:    ENTERPRISE_GATEWAY_HTTP_OPERATION,
    ref:          { integrationId: ENTERPRISE_GATEWAY_INTEGRATION_ID, accountId: input.accountId },
    url:          `${ origin }${ path }`,
    method:       input.method,
    headers:      { accept: 'application/json', 'content-type': 'application/json' },
    body:         input.body,
    injections:   [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
    responseType: 'json',
  };
}
