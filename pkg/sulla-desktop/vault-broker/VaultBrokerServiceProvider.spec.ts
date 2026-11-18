import { describe, expect, it, vi } from 'vitest';
import { VaultBrokerServiceProvider } from './VaultBrokerServiceProvider';

describe('VaultBrokerServiceProvider principal cache', () => {
  it('reuses an unlocked principal and retries after a locked response', async() => {
    // risk: permissions — stale principal data must not survive a broker lock response.
    const provider = new VaultBrokerServiceProvider({ SULLA_VAULT_BROKER_TOKEN: 'fixture', SULLA_VAULT_BROKER_SERVICE_ID: 'sulla-tools' }, () => false);
    const broker = { status: vi.fn().mockResolvedValueOnce({ unlocked: true, principalId: '123e4567-e89b-42d3-a456-426614174000' }).mockRejectedValueOnce(Object.assign(new Error('locked'), { status: 423 })).mockResolvedValueOnce({ unlocked: true, principalId: '123e4567-e89b-42d3-a456-426614174001' }) };
    provider.configureCredentialBroker(broker as never);
    const first = await provider.getLocalVaultPrincipalId();
    expect(await provider.getLocalVaultPrincipalId()).toBe(first);
    await expect(provider.getLocalVaultPrincipalId()).rejects.toMatchObject({ status: 423 });
    expect(await provider.getLocalVaultPrincipalId()).toBe('123e4567-e89b-42d3-a456-426614174001');
    expect(broker.status).toHaveBeenCalledTimes(3);
  });
});
