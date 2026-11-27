// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { promises as dns } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrokerAddressPolicy } from '../src/localAuthority/BrokerAddressPolicy.js';
import { UpstreamHttpClient } from '../src/localAuthority/UpstreamHttpClient.js';
import { ValidatedUpstreamResolver } from '../src/localAuthority/ValidatedUpstreamResolver.js';
import type { LocalAuthorityHost } from '../src/localAuthority/LocalAuthorityHost.js';

const publicAddresses = [{ address: '93.184.216.34', family: 4 }];
const testUrl = 'https://models.example.test/v1';

const client = (): UpstreamHttpClient => new UpstreamHttpClient({} as LocalAuthorityHost);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('UpstreamHttpClient DNS resolution', () => {
  it('coalesces 50 concurrent validations for the same hostname into one DNS lookup', async() => {
    // risk: availability — one saturated event burst must not enqueue 50 DNS jobs on libuv's shared pool.
    let releaseLookup!: (addresses: typeof publicAddresses) => void;
    const lookupResult = new Promise<typeof publicAddresses>(resolve => { releaseLookup = resolve; });
    const lookup = vi.spyOn(dns, 'lookup').mockReturnValue(lookupResult as never);
    const upstream = client();

    const validations = Array.from({ length: 50 }, () => upstream.validateTarget(testUrl));
    expect(lookup).toHaveBeenCalledTimes(1);

    releaseLookup(publicAddresses);
    await expect(Promise.all(validations)).resolves.toHaveLength(50);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('reuses a successful result within 30 seconds and resolves again after the TTL', async() => {
    // risk: availability — repeated provider starts stay off the DNS worker queue until the bounded TTL expires.
    vi.useFakeTimers();
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue(publicAddresses as never);
    const upstream = client();

    await Promise.all(Array.from({ length: 50 }, () => upstream.validateTarget(testUrl)));
    expect(lookup).toHaveBeenCalledTimes(1);

    await Promise.all(Array.from({ length: 50 }, () => upstream.validateTarget(testUrl)));
    expect(lookup).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_001);
    await upstream.validateTarget(testUrl);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('rechecks the address policy for a cached result instead of trusting its old validation', async() => {
    // risk: SSRF bypass — cached pins must still be rejected if the address policy considers them private.
    const privateAddress = [{ address: '127.0.0.1', family: 4 }];
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue(privateAddress as never);
    const isPrivate = vi.spyOn(BrokerAddressPolicy, 'privateAddress')
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const upstream = client();

    await upstream.validateTarget(testUrl);
    await expect(upstream.validateTarget(testUrl)).rejects.toMatchObject({ code: 'destination_denied', status: 403 });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(isPrivate).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup and can resolve the hostname on the next request', async() => {
    // risk: availability — a transient DNS failure must not poison the host cache for the full TTL.
    const lookup = vi.spyOn(dns, 'lookup')
      .mockRejectedValueOnce(Object.assign(new Error('synthetic DNS failure'), { code: 'ENOTFOUND' }) as never)
      .mockResolvedValue(publicAddresses as never);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const upstream = client();

    await expect(upstream.validateTarget(testUrl)).rejects.toMatchObject({ code: 'upstream_failed', status: 502 });
    expect(lookup).toHaveBeenCalledTimes(1);

    await expect(upstream.validateTarget(testUrl)).resolves.toMatchObject({ pinnedAddress: publicAddresses[0].address });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used host when the cache reaches its configured bound', async() => {
    // risk: availability — attacker-controlled distinct hostnames cannot grow resolver memory without bound.
    const lookup = vi.fn(async() => publicAddresses);
    const resolver = new ValidatedUpstreamResolver({ lookup, maxCacheEntries: 2, now: () => 0 });

    await resolver.resolve('first.example.test');
    await resolver.resolve('second.example.test');
    await resolver.resolve('first.example.test');
    await resolver.resolve('third.example.test');
    await resolver.resolve('second.example.test');

    expect(lookup).toHaveBeenCalledTimes(4);
    expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual([
      'first.example.test', 'second.example.test', 'third.example.test', 'second.example.test',
    ]);
  });
});
