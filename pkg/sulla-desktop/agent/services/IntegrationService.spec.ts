import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationService } from './IntegrationService';

describe('IntegrationService active-account cache', () => {
  afterEach(() => vi.useRealTimers());

  it('hits the cache, expires it after 60 seconds, and invalidates after setting an account', async() => {
    // risk: correctness — account-scoped operations must follow the latest active account.
    vi.useFakeTimers();
    const service = new IntegrationService();
    const read = vi.spyOn(service as any, 'getLocalMetadata').mockResolvedValue({ activeAccountId: 'account-a', accounts: [] });
    vi.spyOn(service as any, 'setLocalActiveAccount').mockResolvedValue({ activeAccountId: 'account-b', accounts: [] });

    expect(await service.getActiveAccountId('mail')).toBe('account-a');
    expect(await service.getActiveAccountId('mail')).toBe('account-a');
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await service.getActiveAccountId('mail')).toBe('account-a');
    expect(read).toHaveBeenCalledTimes(2);

    await service.setActiveAccount('mail', 'account-b');
    expect(await service.getActiveAccountId('mail')).toBe('account-a');
    expect(read).toHaveBeenCalledTimes(3);
  });
});
