// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { renderEgressRestore } from './threatProxyEgress';

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
