import assert from 'node:assert/strict';
import test from 'node:test';

import { ENTERPRISE_GATEWAY_INJECTION, validateEnterpriseGatewayHttp } from './gatewayPolicy.js';

import type { BrokerExecuteRequest } from './contracts.js';

const request: BrokerExecuteRequest = {
  claims: {
    sub: '00000000-0000-4000-8000-000000000001',
    agent_id: 'gateway-listener',
    pod_id: 'desktop-main',
    credential_scope: { integration_id: 'enterprise_gateway', account_id: 'default' },
  },
  operation:  'enterprise.gateway.http',
  ref:        { integrationId: 'enterprise_gateway', accountId: 'default' },
  url:        'https://gateway.example.test/api/desktop/sessions',
  method:     'POST',
  body:       { callerName: 'Sulla Desktop' },
  injections: [ENTERPRISE_GATEWAY_INJECTION],
};

test('enterprise gateway policy binds the configured origin and exact session routes', () => {
  assert.equal(validateEnterpriseGatewayHttp(request, 'https://gateway.example.test').target.origin, 'https://gateway.example.test');
  assert.throws(() => validateEnterpriseGatewayHttp({ ...request, url: 'https://attacker.test/api/desktop/sessions' }, 'https://gateway.example.test'), /destination_denied/);
  assert.throws(() => validateEnterpriseGatewayHttp({ ...request, url: 'https://gateway.example.test/admin' }, 'https://gateway.example.test'), /destination_denied/);
  assert.throws(() => validateEnterpriseGatewayHttp({ ...request, injections: [] }, 'https://gateway.example.test'), /injection_denied/);
});
