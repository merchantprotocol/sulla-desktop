import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationService } from './IntegrationService';

// IntegrationService pulls in the vault-broker transport, which imports Electron at module load.
vi.mock('electron', () => {
  const app = { on: vi.fn(), isPackaged: false, getPath: vi.fn(() => '/tmp') };
  const safeStorage = { isEncryptionAvailable: vi.fn(() => true), decryptString: vi.fn(), encryptString: vi.fn() };
  const session = { fromPartition: vi.fn() };

  return { default: { app, safeStorage, session }, app, safeStorage, session };
});
vi.mock('@pkg/agent/database/models/IntegrationValueModel', () => ({ IntegrationValueModel: {} }));

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
