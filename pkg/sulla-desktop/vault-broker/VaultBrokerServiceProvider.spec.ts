import { describe, expect, it, vi } from 'vitest';
import { VaultBrokerServiceProvider } from './VaultBrokerServiceProvider';
import { LocalVaultBrokerClient } from './index';

describe('LocalVaultBrokerClient stream routing', () => {
  it('sends relay event responses through the stream transport', async() => {
    // risk: availability — lifetime relay sockets must not exhaust the control pool.
    const control = vi.fn(async() => new Response('{}'));
    const stream = vi.fn(async() => new Response('{}'));
    const client = new LocalVaultBrokerClient('https://127.0.0.1:30135', { serviceId: 'sulla-tools', serviceToken: 'fixture' }, control, stream);
    await client.relayEvents('relay-1');
    expect(control).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

describe('VaultBrokerServiceProvider principal cache', () => {
  it('expires the principal cache after 60 seconds', async() => {
    // risk: permissions — a recreated vault must not inherit a stale principal indefinitely.
    vi.useFakeTimers();
    try {
      const provider = new VaultBrokerServiceProvider({ SULLA_VAULT_BROKER_TOKEN: 'fixture', SULLA_VAULT_BROKER_SERVICE_ID: 'sulla-tools' }, () => false);
      const broker = { status: vi.fn().mockResolvedValueOnce({ unlocked: true, principalId: '123e4567-e89b-42d3-a456-426614174000' }).mockResolvedValueOnce({ unlocked: true, principalId: '123e4567-e89b-42d3-a456-426614174001' }) };
      provider.configureCredentialBroker(broker as never);
      expect(await provider.getLocalVaultPrincipalId()).toBe('123e4567-e89b-42d3-a456-426614174000');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await provider.getLocalVaultPrincipalId()).toBe('123e4567-e89b-42d3-a456-426614174001');
      expect(broker.status).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('invalidates a cached principal when a transport observes a locked response', async() => {
    // risk: permissions — a 423 must invalidate identity even after the cache has loaded.
    const provider = new VaultBrokerServiceProvider({ SULLA_VAULT_BROKER_TOKEN: 'fixture', SULLA_VAULT_BROKER_SERVICE_ID: 'sulla-tools' }, () => false);
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ unlocked: true, principalId: '123e4567-e89b-42d3-a456-426614174000' }))
      .mockResolvedValueOnce(Response.json({ error: 'vault_locked', message: 'locked' }, { status: 423 }))
      .mockResolvedValueOnce(Response.json({ unlocked: true, principalId: '123e4567-e89b-42d3-a456-426614174001' }));
    const broker = new LocalVaultBrokerClient('https://127.0.0.1:30135', { serviceId: 'sulla-tools', serviceToken: 'fixture' }, transport, transport, () => provider.invalidatePrincipalCache());
    provider.configureCredentialBroker(broker);
    expect(await provider.getLocalVaultPrincipalId()).toBe('123e4567-e89b-42d3-a456-426614174000');
    await expect(broker.status()).rejects.toMatchObject({ status: 423 });
    expect(await provider.getLocalVaultPrincipalId()).toBe('123e4567-e89b-42d3-a456-426614174001');
  });

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
