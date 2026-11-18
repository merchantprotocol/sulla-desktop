// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { agentCaTrust, renderEgressRestore } from './threatProxyEgress';

describe('threat proxy egress policy', () => {
  // risk: network policy — direct must not redirect or reject public web TCP.
  it('direct mode removes redirects and accepts escaped web traffic while retaining QUIC and IPv6 blocks', () => {
    const rules = renderEgressRestore('direct');
    expect(rules).not.toContain('REDIRECT');
    expect(rules).toContain('--dports 80,443 -j ACCEPT');
    expect(rules).toContain('udp -j REJECT');
  });
  // risk: network policy — enforced mode rejects any web flow escaping inspection.
  it('enforced mode redirects web traffic and rejects escaped web traffic', () => {
    const rules = renderEgressRestore('enforced');
    expect(rules).toContain('REDIRECT --to-ports 8890');
    expect(rules).toContain('--dports 80,443 -j REJECT');
  });
});

describe('agent CA trust', () => {
  // risk: TLS availability — first-boot direct agents must not point clients at nonexistent CA files.
  it('omits both CA env and bind when the bundle is absent', () => {
    expect(agentCaTrust(false)).toEqual({ env: {} });
  });
  // risk: TLS inspection — enforced agents trust the proxy CA across supported clients.
  it('provides the CA bind and client trust variables when present', () => {
    const trust = agentCaTrust();
    expect(trust.bind).toContain(':ro');
    expect(trust.env).toMatchObject({ SSL_CERT_FILE: expect.any(String), REQUESTS_CA_BUNDLE: expect.any(String), GIT_SSL_CAINFO: expect.any(String) });
  });
});
