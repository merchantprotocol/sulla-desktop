// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';

import type { BrokerInjection } from '../../../vault-broker';
import type { IntegrationAccount } from '../../services/IntegrationService';
import type { ExpiringRequestCache } from './ExpiringRequestCache';
import type {
  IntegrationAccountCatalogRepository,
  ModelListLane,
  ProviderCatalogStrategyRegistry,
} from './BrokeredModelCatalogStrategies';

const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

export interface BrokeredModelListRequest {
  providerId: string;
  accountId: string;
  url: string;
  injections: BrokerInjection[];
  headers?: Record<string, string>;
}

export interface BrokeredModelHttpTransport {
  execute(request: BrokeredModelListRequest): Promise<unknown>;
}

export interface CatalogLogger {
  warn(message: string): void;
}

export class BrokeredModelCatalogService extends Service {
  constructor(
    private readonly strategies: ProviderCatalogStrategyRegistry,
    private readonly accounts: IntegrationAccountCatalogRepository,
    private readonly transport: BrokeredModelHttpTransport,
    private readonly cache: ExpiringRequestCache<unknown>,
    private readonly logger: CatalogLogger,
  ) {
    super();
  }

  async resolveAccount(
    providerId: string,
    preferredAccountId?: string,
    accountsInput?: IntegrationAccount[],
  ): Promise<IntegrationAccount | null> {
    try {
      const accounts = accountsInput ?? await this.accounts.list(providerId);
      const strategy = this.strategies.get(providerId);
      return strategy?.selectAccount(accounts, preferredAccountId) ?? this.selectDefaultAccount(accounts, preferredAccountId);
    } catch {
      return null;
    }
  }

  async fetch<T = unknown>(request: BrokeredModelListRequest): Promise<T | null> {
    return this.cache.getOrLoad(this.cacheKey(request), async() => {
      try {
        const body = await this.transport.execute({ ...request, headers: this.safeHeaders(request.headers) });
        return { value: body, ttlMs: SUCCESS_TTL_MS };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const reason = code ?? (error instanceof Error ? error.message : 'unknown');
        this.logger.warn(`[brokeredModelList] ${request.providerId} model list unavailable (${String(reason).slice(0, 80)}); returning no models`);
        return { value: null, ttlMs: FAILURE_TTL_MS };
      }
    }) as Promise<T | null>;
  }

  async list<T = unknown>(
    providerId: string,
    preferredAccountId?: string,
    extraHeaders?: (lane: ModelListLane) => Record<string, string>,
  ): Promise<{ body: T | null; lane: ModelListLane | null }> {
    const strategy = this.strategies.get(providerId);
    if (!strategy) return { body: null, lane: null };

    let account: IntegrationAccount | null;
    try {
      const available = await this.accounts.list(providerId);
      account = strategy.selectAccount(available, preferredAccountId);
    } catch {
      return { body: null, lane: null };
    }
    if (!account) return { body: null, lane: null };

    const lane = strategy.lane(account.account_id);
    const providerHeaders = await strategy.headers(account.account_id, this.accounts);
    const body = await this.fetch<T>({
      providerId,
      accountId: account.account_id,
      url: lane.url,
      injections: lane.injections,
      headers: { ...(lane.headers ?? {}), ...providerHeaders, ...(extraHeaders?.(lane) ?? {}) },
    });
    return { body, lane };
  }

  lane(providerId: string, accountId: string): ModelListLane | null {
    return this.strategies.get(providerId)?.lane(accountId) ?? null;
  }

  clear(): void {
    this.cache.clear();
  }

  private selectDefaultAccount(accounts: IntegrationAccount[], preferredAccountId?: string): IntegrationAccount | null {
    const connected = accounts.filter(account => account.connected);
    return connected.find(account => preferredAccountId !== undefined && account.account_id === preferredAccountId) ??
      connected.find(account => account.active) ?? connected[0] ?? null;
  }

  private cacheKey(request: BrokeredModelListRequest): string {
    return `${request.providerId}\u0000${request.accountId}\u0000${request.url}`;
  }

  private safeHeaders(headers: Record<string, string> = {}): Record<string, string> {
    const blocked = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization']);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
  }
}
