import { describe, expect, it } from '@jest/globals';

import { resolveAgentIdentity } from '../agentIdentity';

describe('resolveAgentIdentity', () => {
  it('keeps the graph-created identity when the delivery channel changes', () => {
    const metadata = {
      agentId:   'sulla-desktop',
      wsChannel: 'mobile-relay',
    };

    expect(resolveAgentIdentity(metadata)).toBe('sulla-desktop');
  });

  it('falls back to wsChannel for older state without agentId', () => {
    expect(resolveAgentIdentity({ wsChannel: 'heartbeat' })).toBe('heartbeat');
  });

  it('trims identity values and handles missing metadata', () => {
    expect(resolveAgentIdentity({ agentId: '  operator  ', wsChannel: 'mobile-relay' })).toBe('operator');
    expect(resolveAgentIdentity(undefined)).toBe('');
  });
});
