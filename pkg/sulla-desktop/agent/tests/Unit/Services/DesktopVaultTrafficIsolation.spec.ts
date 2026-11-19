// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';
import { describe, expect, it, vi } from 'vitest';

import { configureVaultPinnedSession } from '../../../../main/vaultTls';
import { desktopVaultFetch } from '../../../../vault-broker/desktopTransport';
const f = vi.hoisted(() => ({ partitions: new Map<string, any>() }));
vi.mock('electron', () => ({ default: { safeStorage: { isEncryptionAvailable: () => true }, session: { fromPartition: (name: string) => { const value = { fetch: vi.fn(() => Promise.resolve(new Response('{}'))) }; f.partitions.set(name, value); return value } } } }));
vi.mock('@pkg/main/vaultTls', () => ({ configureVaultPinnedSession: vi.fn(() => Promise.resolve()) }));
describe('desktop vault traffic isolation', () => {
  it('pins both pools and keeps status, credentials and relay controls off the provider response pool', async() => {
    const base = 'https://127.0.0.1:30135';
    for (const path of ['/v1/broker/execute-stream', '/v1/broker/execute', '/v1/broker/relay/fixture/events']) await desktopVaultFetch(base + path);
    for (const path of ['/v1/broker/status', '/v1/broker/integrations/codex/metadata', '/v1/broker/relay/fixture/send', '/v1/broker/relay/fixture', '/v1/desktop/cloud-sync/status']) await desktopVaultFetch(base + path);
    expect(f.partitions.size).toBe(2);
    expect(f.partitions.get('sulla-vault-broker').fetch).toHaveBeenCalledTimes(3);
    expect(f.partitions.get('sulla-vault-broker-control').fetch).toHaveBeenCalledTimes(5);
    expect(configureVaultPinnedSession).toHaveBeenCalledTimes(2);
    const signal = AbortSignal.timeout(1000); await desktopVaultFetch(base + '/v1/broker/status', { signal });
    expect(f.partitions.get('sulla-vault-broker-control').fetch).toHaveBeenLastCalledWith(base + '/v1/broker/status', { signal });
  });
});
