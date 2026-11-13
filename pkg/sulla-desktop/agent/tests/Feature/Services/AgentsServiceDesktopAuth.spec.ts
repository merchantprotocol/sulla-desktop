import { beforeAll, describe, expect, it, vi } from 'vitest';

// risk: permissions — the Desktop-only service must accept its local API token and reject all other callers.
describe('Agents service Desktop authentication', () => {
  let authenticateRequest: typeof import('../../../../../../services/sulla-agents/src/auth.js').authenticateRequest;

  beforeAll(async() => {
    vi.stubEnv('SULLA_API_TOKEN', 'desktop-test-token-that-is-long-enough-for-the-service');
    ({ authenticateRequest } = await import('../../../../../../services/sulla-agents/src/auth.js'));
  });

  it('authenticates the Desktop token as the local owner', () => {
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    authenticateRequest({ header: () => 'Bearer desktop-test-token-that-is-long-enough-for-the-service' } as any, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('rejects a wrong local token without advancing the request', () => {
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    authenticateRequest({ header: () => 'Bearer wrong-token' } as any, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'authentication_required' });
  });
});
