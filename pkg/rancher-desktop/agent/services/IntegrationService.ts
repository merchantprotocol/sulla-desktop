// IntegrationService - PostgreSQL-backed integration configuration management
// Provides CRUD operations for integration connection properties
// Supports multiple accounts per integration via account_id

import { IntegrationValueModel } from '../database/models/IntegrationValueModel';
import { getSelectBoxProvider, type SelectOption } from '../integrations/select_box';

const DEFAULT_ACCOUNT_ID = 'default';

export interface IntegrationValue {
  value_id: number;
  integration_id: string;
  account_id: string;
  property: string;
  value: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface IntegrationValueInput {
  integration_id: string;
  account_id?: string;
  property: string;
  value: string;
}

export interface IntegrationConnectionStatus {
  integration_id: string;
  account_id: string;
  connected: boolean;
  connected_at?: Date;
  last_sync_at?: Date;
}

export interface IntegrationAccount {
  integration_id: string;
  account_id: string;
  label: string;
  active: boolean;
  connected: boolean;
  connected_at?: Date;
}

// Special properties that are not shown in forms
const SYSTEM_PROPERTIES = ['connection_status', 'connected_at', 'last_sync_at', 'account_label'];

type IntegrationValueCallback = (value: IntegrationValue, action: 'created' | 'updated' | 'deleted') => void;

let integrationServiceInstance: IntegrationService | null = null;

export function getIntegrationService(): IntegrationService {
  if (!integrationServiceInstance) {
    integrationServiceInstance = new IntegrationService();
  }
  return integrationServiceInstance;
}

export class IntegrationService {
  private initialized = false;
  private valueCallbacks: IntegrationValueCallback[] = [];

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[IntegrationService] Initializing...');
    this.initialized = true;
    console.log('[IntegrationService] Initialized');
  }

  onValueChange(callback: IntegrationValueCallback): void {
    this.valueCallbacks.push(callback);
  }

  private notifyValueChange(value: IntegrationValue, action: 'created' | 'updated' | 'deleted'): void {
    for (const callback of this.valueCallbacks) {
      try {
        callback(value, action);
      } catch (err) {
        console.warn('[IntegrationService] Value callback error:', err);
      }
    }
  }

  private modelToValue(model: IntegrationValueModel): IntegrationValue {
    return {
      value_id: model.attributes.value_id as number,
      integration_id: model.attributes.integration_id as string,
      account_id: (model.attributes.account_id as string) || DEFAULT_ACCOUNT_ID,
      property: model.attributes.property as string,
      value: model.attributes.value as string,
      is_default: !!model.attributes.is_default,
      created_at: model.attributes.created_at as Date,
      updated_at: model.attributes.updated_at as Date,
    };
  }

  // ─── Account management ───────────────────────────────────────────

  /** Get the active/default account_id for an integration */
  async getActiveAccountId(integrationId: string): Promise<string> {
    return IntegrationValueModel.getDefaultAccountId(integrationId);
  }

  /** Set which account is the default for an integration.
   *  Clears is_default on all other accounts, sets it on the target. */
  async setActiveAccount(integrationId: string, accountId: string): Promise<void> {
    await IntegrationValueModel.setDefaultAccount(integrationId, accountId);
    console.log(`[IntegrationService] Default account for ${integrationId} set to: ${accountId}`);
  }

  /** Set a human-readable label for an account */
  async setAccountLabel(integrationId: string, accountId: string, label: string): Promise<void> {
    await this.setIntegrationValue({
      integration_id: integrationId,
      account_id: accountId,
      property: 'account_label',
      value: label,
    });
  }

  /** Get the label for an account */
  async getAccountLabel(integrationId: string, accountId: string): Promise<string> {
    const model = await IntegrationValueModel.findByKey(integrationId, accountId, 'account_label');
    return model?.attributes.value || accountId;
  }

  /** List all accounts for an integration */
  async getAccounts(integrationId: string): Promise<IntegrationAccount[]> {
    const accountIds = await IntegrationValueModel.getDistinctAccounts(integrationId);
    const accounts: IntegrationAccount[] = [];

    for (const accountId of accountIds) {
      const label = await this.getAccountLabel(integrationId, accountId);
      const status = await this.getConnectionStatus(integrationId, accountId);

      // Check is_default from any row for this account
      const accountRows = await IntegrationValueModel.findByAccount(integrationId, accountId);
      const isDefault = accountRows.some(m => !!m.attributes.is_default);

      accounts.push({
        integration_id: integrationId,
        account_id: accountId,
        label,
        active: isDefault,
        connected: status.connected,
        connected_at: status.connected_at,
      });
    }

    return accounts;
  }

  /** Delete an entire account and all its values */
  async deleteAccount(integrationId: string, accountId: string): Promise<boolean> {
    const models = await IntegrationValueModel.findByAccount(integrationId, accountId);
    if (models.length === 0) return false;

    const wasDefault = models.some(m => !!m.attributes.is_default);

    for (const model of models) {
      const value = this.modelToValue(model);
      await model.delete();
      this.notifyValueChange(value, 'deleted');
    }

    console.log(`[IntegrationService] Deleted account ${accountId} for ${integrationId}`);

    // If the deleted account was the default, assign default to the first remaining account
    if (wasDefault) {
      const remainingAccounts = await IntegrationValueModel.getDistinctAccounts(integrationId);
      if (remainingAccounts.length > 0) {
        await IntegrationValueModel.setDefaultAccount(integrationId, remainingAccounts[0]);
        console.log(`[IntegrationService] Reassigned default to ${remainingAccounts[0]} for ${integrationId}`);
      }
    }

    return true;
  }

  // ─── Value CRUD (account-aware) ───────────────────────────────────

  async setIntegrationValue(input: IntegrationValueInput): Promise<IntegrationValue> {
    const accountId = input.account_id || DEFAULT_ACCOUNT_ID;

    // If this is the first account for this integration, auto-mark as default
    const existingAccounts = await IntegrationValueModel.getDistinctAccounts(input.integration_id);
    const isFirstAccount = existingAccounts.length === 0 || (existingAccounts.length === 1 && existingAccounts[0] === accountId);

    const { model, wasUpdate } = await IntegrationValueModel.upsert(
      input.integration_id,
      accountId,
      input.property,
      input.value,
    );

    // Auto-set default on first account
    if (isFirstAccount && !model.attributes.is_default) {
      await IntegrationValueModel.setDefaultAccount(input.integration_id, accountId);
    }

    const action = wasUpdate ? 'updated' : 'created';
    console.log(`[IntegrationService] ${wasUpdate ? 'Updated' : 'Created'} value: ${input.integration_id}/${accountId}.${input.property}`);

    const value = this.modelToValue(model);
    this.notifyValueChange(value, action);
    return value;
  }

  async setMultipleValues(inputs: IntegrationValueInput[]): Promise<IntegrationValue[]> {
    const values: IntegrationValue[] = [];
    
    for (const input of inputs) {
      const value = await this.setIntegrationValue(input);
      values.push(value);
    }
    
    return values;
  }

  // ─── Connection status (account-aware) ────────────────────────────

  async setConnectionStatus(integrationId: string, connected: boolean, accountId?: string): Promise<void> {
    const acctId = accountId || DEFAULT_ACCOUNT_ID;

    await this.setIntegrationValue({
      integration_id: integrationId,
      account_id: acctId,
      property: 'connection_status',
      value: connected.toString()
    });

    if (connected) {
      await this.setIntegrationValue({
        integration_id: integrationId,
        account_id: acctId,
        property: 'connected_at',
        value: new Date().toISOString()
      });
    }

    await this.setIntegrationValue({
      integration_id: integrationId,
      account_id: acctId,
      property: 'last_sync_at',
      value: new Date().toISOString()
    });
  }

  async getConnectionStatus(integrationId: string, accountId?: string): Promise<IntegrationConnectionStatus> {
    const acctId = accountId || DEFAULT_ACCOUNT_ID;

    const statusModel = await IntegrationValueModel.findByKey(integrationId, acctId, 'connection_status');
    const connectedAtModel = await IntegrationValueModel.findByKey(integrationId, acctId, 'connected_at');
    const lastSyncModel = await IntegrationValueModel.findByKey(integrationId, acctId, 'last_sync_at');

    return {
      integration_id: integrationId,
      account_id: acctId,
      connected: statusModel?.attributes.value === 'true',
      connected_at: connectedAtModel ? new Date(connectedAtModel.attributes.value as string) : undefined,
      last_sync_at: lastSyncModel ? new Date(lastSyncModel.attributes.value as string) : undefined
    };
  }

  /** Check if ANY account for this integration is connected */
  async isAnyAccountConnected(integrationId: string): Promise<boolean> {
    return IntegrationValueModel.existsWithPropertyValue(integrationId, 'connection_status', 'true');
  }

  // ─── Form values (account-aware) ─────────────────────────────────

  /** Get form values for the active account (or a specific account) */
  async getFormValues(integrationId: string, accountId?: string): Promise<IntegrationValue[]> {
    const acctId = accountId || await this.getActiveAccountId(integrationId);

    const models = await IntegrationValueModel.getFormValues(integrationId, acctId, SYSTEM_PROPERTIES);

    console.log(`[IntegrationService] Fetched ${models.length} form values for ${integrationId}/${acctId}`);
    return models.map(m => this.modelToValue(m));
  }

  async setFormValues(inputs: IntegrationValueInput[]): Promise<IntegrationValue[]> {
    const filteredInputs = inputs.filter(input => !SYSTEM_PROPERTIES.includes(input.property));
    return this.setMultipleValues(filteredInputs);
  }

  // ─── Raw value access (account-aware) ─────────────────────────────

  /** Get a value from the active account (backward-compat) */
  async getIntegrationValue(integrationId: string, property: string, accountId?: string): Promise<IntegrationValue | null> {
    const acctId = accountId || await this.getActiveAccountId(integrationId);
    const model = await IntegrationValueModel.findByKey(integrationId, acctId, property);
    return model ? this.modelToValue(model) : null;
  }

  /** Get all values for the active account (backward-compat) */
  async getIntegrationValues(integrationId: string, accountId?: string): Promise<IntegrationValue[]> {
    const acctId = accountId || await this.getActiveAccountId(integrationId);
    const models = await IntegrationValueModel.findByAccount(integrationId, acctId);
    return models.map(m => this.modelToValue(m));
  }

  async getAllIntegrationValues(): Promise<IntegrationValue[]> {
    const models = await IntegrationValueModel.all();
    console.log(`[IntegrationService] Fetched ${models.length} total values`);
    return models.map(m => this.modelToValue(m));
  }

  // ─── Delete (account-aware) ───────────────────────────────────────

  async deleteIntegrationValue(integrationId: string, property: string, accountId?: string): Promise<boolean> {
    const acctId = accountId || await this.getActiveAccountId(integrationId);

    const model = await IntegrationValueModel.findByKey(integrationId, acctId, property);
    if (!model) return false;

    const value = this.modelToValue(model);
    await model.delete();
    console.log(`[IntegrationService] Deleted value: ${integrationId}/${acctId}.${property}`);
    this.notifyValueChange(value, 'deleted');
    return true;
  }

  // ─── Select box options ──────────────────────────────────────────

  /**
   * Resolve select box options for a property.
   * Passes current form values to the provider so it can use credentials to call APIs.
   */
  async getSelectOptions(
    selectBoxId: string,
    integrationId: string,
    accountId: string,
    formValues: Record<string, string>,
  ): Promise<SelectOption[]> {
    const provider = getSelectBoxProvider(selectBoxId);

    if (!provider) {
      console.warn(`[IntegrationService] No SelectBoxProvider found for id: ${ selectBoxId }`);

      return [];
    }

    return provider.getOptions({ integrationId, accountId, formValues });
  }

  // ─── OAuth convenience methods ──────────────────────────────────

  /**
   * Start an OAuth 2.0 authorization flow for an integration.
   * Lazy-loads OAuthService to avoid circular deps.
   */
  async startOAuthFlow(
    integrationId: string,
    providerId: string,
    clientId: string,
    clientSecret: string,
    accountId?: string,
    extraScopes?: string[],
  ): Promise<import('../integrations/oauth/OAuthProvider').OAuthTokenSet> {
    const { getOAuthService } = await import('./OAuthService');
    const oauthService = getOAuthService();
    return oauthService.startFlow(
      integrationId, providerId, clientId, clientSecret,
      accountId || DEFAULT_ACCOUNT_ID, extraScopes || [],
    );
  }

  /**
   * Get a valid access token for an OAuth integration, auto-refreshing if needed.
   */
  async getOAuthAccessToken(integrationId: string, accountId?: string): Promise<string> {
    const { getOAuthService } = await import('./OAuthService');
    const oauthService = getOAuthService();
    return oauthService.getAccessToken(integrationId, accountId || DEFAULT_ACCOUNT_ID);
  }

  /**
   * Revoke and delete OAuth tokens, disconnecting the account.
   */
  async revokeOAuthTokens(integrationId: string, accountId?: string): Promise<void> {
    const { getOAuthService } = await import('./OAuthService');
    const oauthService = getOAuthService();
    return oauthService.revokeTokens(integrationId, accountId || DEFAULT_ACCOUNT_ID);
  }

  async deleteIntegrationValues(integrationId: string, accountId?: string): Promise<boolean> {
    if (accountId) {
      return this.deleteAccount(integrationId, accountId);
    }

    const models = await IntegrationValueModel.findByIntegration(integrationId);
    if (models.length === 0) return false;

    for (const model of models) {
      const value = this.modelToValue(model);
      await model.delete();
      this.notifyValueChange(value, 'deleted');
    }

    console.log(`[IntegrationService] Deleted ${models.length} values for ${integrationId}`);
    return true;
  }
}
