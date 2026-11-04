// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BrokerInjection } from '../../../vault-broker';
import type { IntegrationAccount } from '../../services/IntegrationService';

const ANTHROPIC_API_KEY: BrokerInjection = { field: 'api_key', target: 'header', name: 'x-api-key', scheme: 'raw' };
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';

export interface ModelListLane {
  url: string;
  injections: BrokerInjection[];
  headers?: Record<string, string>;
  oauth: boolean;
}

export interface IntegrationAccountCatalogRepository {
  list(providerId: string): Promise<IntegrationAccount[]>;
  metadata(providerId: string, accountId: string): Promise<Array<{ property: string; value: string }>>;
}

export interface ProviderCatalogStrategy {
  readonly providerId: string;
  selectAccount(accounts: IntegrationAccount[], preferredAccountId?: string): IntegrationAccount | null;
  lane(accountId: string): ModelListLane;
  headers(accountId: string, repository: IntegrationAccountCatalogRepository): Promise<Record<string, string>>;
}

abstract class BaseProviderCatalogStrategy implements ProviderCatalogStrategy {
  abstract readonly providerId: string;
  abstract lane(accountId: string): ModelListLane;

  selectAccount(accounts: IntegrationAccount[], preferredAccountId?: string): IntegrationAccount | null {
    const connected = accounts.filter(account => account.connected);
    return connected.find(account => preferredAccountId !== undefined && account.account_id === preferredAccountId) ??
      connected.find(account => account.active) ?? connected[0] ?? null;
  }

  async headers(_accountId: string, _repository: IntegrationAccountCatalogRepository): Promise<Record<string, string>> {
    return {};
  }

  protected bearer(field: string): BrokerInjection {
    return { field, target: 'header', name: 'authorization', scheme: 'Bearer' };
  }

  protected async workspaceHeader(
    accountId: string,
    repository: IntegrationAccountCatalogRepository,
  ): Promise<Record<string, string>> {
    try {
      const metadata = await repository.metadata(this.providerId, accountId);
      const workspaceId = metadata.find(value => value.property === 'workspace_id')?.value.trim();
      return workspaceId ? { 'anthropic-workspace-id': workspaceId } : {};
    } catch {
      return {};
    }
  }
}

export class AnthropicCatalogStrategy extends BaseProviderCatalogStrategy {
  readonly providerId = 'anthropic';

  lane(): ModelListLane {
    return { url: ANTHROPIC_MODELS_URL, injections: [ANTHROPIC_API_KEY], headers: { 'anthropic-version': '2023-06-01' }, oauth: false };
  }

  override headers(accountId: string, repository: IntegrationAccountCatalogRepository): Promise<Record<string, string>> {
    return this.workspaceHeader(accountId, repository);
  }
}

export class ClaudeCodeCatalogStrategy extends BaseProviderCatalogStrategy {
  readonly providerId = 'claude-code';

  lane(accountId: string): ModelListLane {
    const oauth = accountId === 'oauth';
    return oauth
      ? { url: ANTHROPIC_MODELS_URL, injections: [this.bearer('oauth_token')], headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' }, oauth }
      : { url: ANTHROPIC_MODELS_URL, injections: [ANTHROPIC_API_KEY], headers: { 'anthropic-version': '2023-06-01' }, oauth };
  }

  override headers(accountId: string, repository: IntegrationAccountCatalogRepository): Promise<Record<string, string>> {
    return accountId === 'oauth' ? Promise.resolve({}) : this.workspaceHeader(accountId, repository);
  }
}

export class OpenAiCatalogStrategy extends BaseProviderCatalogStrategy {
  readonly providerId = 'openai';

  lane(): ModelListLane {
    return { url: 'https://api.openai.com/v1/models', injections: [this.bearer('api_key')], oauth: false };
  }
}

export class GrokCatalogStrategy extends BaseProviderCatalogStrategy {
  readonly providerId = 'grok';

  override selectAccount(accounts: IntegrationAccount[], preferredAccountId?: string): IntegrationAccount | null {
    const oauth = accounts.find(account => account.account_id === 'oauth' && account.connected);
    return oauth ?? super.selectAccount(accounts, preferredAccountId);
  }

  lane(accountId: string): ModelListLane {
    const oauth = accountId === 'oauth';
    return oauth
      ? { url: 'https://cli-chat-proxy.grok.com/v1/models', injections: [this.bearer('access_token')], oauth }
      : { url: 'https://api.x.ai/v1/models', injections: [this.bearer('api_key')], oauth };
  }
}

export class ProviderCatalogStrategyRegistry {
  private readonly strategies: ReadonlyMap<string, ProviderCatalogStrategy>;

  constructor(strategies: readonly ProviderCatalogStrategy[]) {
    this.strategies = new Map(strategies.map(strategy => [strategy.providerId, strategy]));
  }

  get(providerId: string): ProviderCatalogStrategy | null {
    return this.strategies.get(providerId) ?? null;
  }

  static defaults(): ProviderCatalogStrategyRegistry {
    return new ProviderCatalogStrategyRegistry([
      new AnthropicCatalogStrategy(),
      new ClaudeCodeCatalogStrategy(),
      new OpenAiCatalogStrategy(),
      new GrokCatalogStrategy(),
    ]);
  }
}
