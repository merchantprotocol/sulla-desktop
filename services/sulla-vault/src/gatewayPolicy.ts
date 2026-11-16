// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrokerExecuteRequest, BrokerInjection } from './contracts.js';

export const ENTERPRISE_GATEWAY_INJECTION: BrokerInjection = {
  field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer',
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SESSION_BODY_BYTES = 64 * 1024;

export interface EnterpriseGatewayHttpDecision {
  target: URL;
}

/** The complete typed REST surface a vault-held enterprise gateway credential may reach. */
export class EnterpriseGatewayPolicy {
  /** The configured gateway as a bare HTTPS origin; anything more specific is refused. */
  origin(raw: string): URL {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        (url.pathname !== '' && url.pathname !== '/')) {
      throw new Error('destination_denied');
    }
    return new URL(url.origin);
  }

  /** Validate the complete typed REST surface before the authority injects a credential. */
  validateHttp(
    input: BrokerExecuteRequest,
    configuredGatewayUrl: string,
  ): EnterpriseGatewayHttpDecision {
    if (input.operation !== 'enterprise.gateway.http' || input.ref.integrationId !== 'enterprise_gateway') {
      throw new Error('integration_denied');
    }
    const configured = this.origin(configuredGatewayUrl);
    const target = new URL(input.url);
    if (target.protocol !== 'https:' || target.origin !== configured.origin || target.username || target.password ||
        target.search || target.hash) {
      throw new Error('destination_denied');
    }
    const method = input.method.toUpperCase();
    const create = method === 'POST' && target.pathname === '/api/desktop/sessions';
    const match = /^\/api\/desktop\/sessions\/([^/]+)$/.exec(target.pathname);
    const remove = method === 'DELETE' && !!match && SESSION_ID.test(decodeURIComponent(match[1]));
    if (!create && !remove) throw new Error('destination_denied');
    if (input.injections.length !== 1 || !this.sameInjection(input.injections[0], ENTERPRISE_GATEWAY_INJECTION)) {
      throw new Error('injection_denied');
    }
    if (create && (!input.body || typeof input.body !== 'object' || Array.isArray(input.body) ||
        Buffer.byteLength(JSON.stringify(input.body)) > MAX_SESSION_BODY_BYTES)) {
      throw new Error('request_denied');
    }
    if (remove && input.body != null) throw new Error('request_denied');
    return { target };
  }

  private sameInjection(left: BrokerInjection, right: BrokerInjection): boolean {
    return left.field === right.field && left.target === right.target &&
      left.name.toLowerCase() === right.name.toLowerCase() && left.scheme === right.scheme;
  }
}

/** @deprecated use EnterpriseGatewayPolicy.origin — E9 alias, removed in final cleanup */
export function enterpriseGatewayOrigin(raw: string): URL {
  return new EnterpriseGatewayPolicy().origin(raw);
}

/** @deprecated use EnterpriseGatewayPolicy.validateHttp — E9 alias, removed in final cleanup */
export function validateEnterpriseGatewayHttp(
  input: BrokerExecuteRequest,
  configuredGatewayUrl: string,
): EnterpriseGatewayHttpDecision {
  return new EnterpriseGatewayPolicy().validateHttp(input, configuredGatewayUrl);
}
