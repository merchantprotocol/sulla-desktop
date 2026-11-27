// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { promises as dns } from 'node:dns';

import type { PinnedAddress } from '../pinnedLookup.js';
import { BrokerAddressPolicy } from './BrokerAddressPolicy.js';
import { LocalVaultError } from './LocalVaultError.js';

interface DnsAddress {
  address: string;
  family: number;
}

interface CachedAddresses {
  addresses: PinnedAddress[];
  expiresAt: number;
}

export interface ValidatedUpstreamResolverOptions {
  lookup?: (hostname: string) => Promise<DnsAddress[]>;
  isPrivateAddress?: (address: string) => boolean;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
}

/** Coalesces DNS work and keeps a 30-second, 256-host LRU cache of policy-validated pins by default. */
export class ValidatedUpstreamResolver {
  private readonly cache = new Map<string, CachedAddresses>();
  private readonly inFlight = new Map<string, Promise<PinnedAddress[]>>();
  private readonly lookup: (hostname: string) => Promise<DnsAddress[]>;
  private readonly isPrivateAddress: (address: string) => boolean;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;

  constructor(options: ValidatedUpstreamResolverOptions = {}) {
    this.lookup = options.lookup ?? (hostname => dns.lookup(hostname, { all: true, verbatim: true }));
    this.isPrivateAddress = options.isPrivateAddress ?? (address => BrokerAddressPolicy.privateAddress(address));
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 30_000);
    this.maxCacheEntries = Math.max(0, options.maxCacheEntries ?? 256);
    this.now = options.now ?? Date.now;
  }

  async resolve(hostname: string, options: { fresh?: boolean } = {}): Promise<PinnedAddress[]> {
    if (options.fresh) this.cache.delete(hostname);

    if (!options.fresh) {
      const cached = this.cache.get(hostname);
      if (cached) {
        if (cached.expiresAt <= this.now()) {
          this.cache.delete(hostname);
        } else {
          const addresses = this.validateAddresses(cached.addresses);
          this.cache.delete(hostname);
          this.cache.set(hostname, { ...cached, addresses });
          return addresses;
        }
      }
    }

    const pending = this.inFlight.get(hostname);
    if (pending) return (await pending).map(address => ({ ...address }));

    const lookup = this.lookupAndCache(hostname);
    this.inFlight.set(hostname, lookup);
    try {
      return (await lookup).map(address => ({ ...address }));
    } finally {
      if (this.inFlight.get(hostname) === lookup) this.inFlight.delete(hostname);
    }
  }

  private async lookupAndCache(hostname: string): Promise<PinnedAddress[]> {
    const addresses = this.validateAddresses(await this.lookup(hostname));
    if (this.cacheTtlMs > 0 && this.maxCacheEntries > 0) {
      const now = this.now();
      for (const [cachedHostname, cached] of this.cache) {
        if (cached.expiresAt <= now) this.cache.delete(cachedHostname);
      }
      this.cache.delete(hostname);
      this.cache.set(hostname, { addresses, expiresAt: now + this.cacheTtlMs });
      while (this.cache.size > this.maxCacheEntries) {
        const oldestHostname = this.cache.keys().next().value;
        if (oldestHostname === undefined) break;
        this.cache.delete(oldestHostname);
      }
    }
    return addresses;
  }

  private validateAddresses(addresses: readonly DnsAddress[]): PinnedAddress[] {
    if (!addresses.length || addresses.some(candidate => this.isPrivateAddress(candidate.address))) {
      throw new LocalVaultError('destination_denied', 403, 'Destination resolved to a private, local, or invalid address');
    }
    return addresses.map(candidate => ({ address: candidate.address, family: candidate.family as 4 | 6 }));
  }
}
