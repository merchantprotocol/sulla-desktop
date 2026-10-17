// IntegrationService - PostgreSQL-backed integration configuration management
// Provides CRUD operations for integration connection properties
// Supports multiple accounts per integration via account_id

import { normalizeVaultCredentialValues, type VaultCredentialReadResult } from './vaultCredentialSchema';
import {
  requireConfiguredCredentialBroker,
  usesContainerVaultAuthority,
  type BrokerIntegrationMetadataResponse,
} from '../../vault-broker';
import { IntegrationValueModel } from '../database/models/IntegrationValueModel';
import { getSelectBoxProvider, type SelectOption } from '../integrations/select_box';

const DEFAULT_ACCOUNT_ID = 'default';
const INTEGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export interface IntegrationValue {
  value_id:       number;
  integration_id: string;
  account_id:     string;
  property:       string;
  value:          string;
  is_default:     boolean;
  created_at:     Date;
  updated_at:     Date;
}

export interface IntegrationValueInput {
  integration_id: string;
  account_id?:    string;
  property:       string;
  value:          string;
}

export interface IntegrationConnectionStatus {
  integration_id: string;
  account_id:     string;
  connected:      boolean;
  connected_at?:  Date;
  last_sync_at?:  Date;
}

export interface IntegrationAccount {
  integration_id: string;
  account_id:     string;
  label:          string;
  active:         boolean;
  connected:      boolean;
  connected_at?:  Date;
}

// Special properties that are not shown in forms
const SYSTEM_PROPERTIES = ['connection_status', 'connected_at', 'last_sync_at', 'account_label'];
const LOCAL_METADATA_PROPERTIES = new Set([
  ...SYSTEM_PROPERTIES,
  'base_url',
  'server_url',
  'gateway_url',
  'provider',
  'provider_id',
  'model',
  'llm_access',
  'client_id',
  'oauth_client_id',
  'expires_at',
  'token_type',
  'scope',
]);

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

    // Notify the main process when running in the renderer, so main-process
    // subscribers (e.g. gateway lobby reconnect) see the change too.
    try {
      if (typeof process !== 'undefined' && process.type === 'renderer') {
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('integration-value-changed', {
          integration_id: value.integration_id,
          property:       value.property,
          action,
        });
      }
    } catch { /* not in renderer or ipc unavailable */ }
  }

  private modelToValue(model: IntegrationValueModel): IntegrationValue {
    return {
      value_id:       model.attributes.value_id!,
      integration_id: model.attributes.integration_id!,
      account_id:     (model.attributes.account_id!) || DEFAULT_ACCOUNT_ID,
      property:       model.attributes.property!,
      value:          model.attributes.value!,
      is_default:     !!model.attributes.is_default,
      created_at:     model.attributes.created_at!,
      updated_at:     model.attributes.updated_at!,
    };
  }

  private isRendererProcess(): boolean {
    return typeof process !== 'undefined' && process.type === 'renderer';
  }

  private validateLocalMetadataIds(integrationId: string, accountId?: string): void {
    if (!INTEGRATION_ID_PATTERN.test(integrationId)) {
      throw new Error('Invalid integration identifier');
    }
    if (accountId !== undefined && !ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error('Invalid integration account identifier');
    }
  }

  /**
   * Renderer code has no vault service identity. It may only use the narrow,
   * metadata-only main-process IPC surface; main/tools call the broker directly.
   */
  private async getLocalMetadata(
    integrationId: string,
    accountId?: string,
  ): Promise<BrokerIntegrationMetadataResponse> {
    this.validateLocalMetadataIds(integrationId, accountId);
    if (this.isRendererProcess()) {
      const { ipcRenderer } = require('electron');
      return ipcRenderer.invoke('vault:integration-metadata', { integrationId, accountId });
    }
    return requireConfiguredCredentialBroker().integrationMetadata(integrationId, accountId);
  }

  private async setLocalActiveAccount(
    integrationId: string,
    accountId: string,
  ): Promise<BrokerIntegrationMetadataResponse> {
    this.validateLocalMetadataIds(integrationId, accountId);
    if (this.isRendererProcess()) {
      const { ipcRenderer } = require('electron');
      return ipcRenderer.invoke('vault:integration-active-account', { integrationId, accountId });
    }
    return requireConfiguredCredentialBroker().setActiveIntegrationAccount(integrationId, accountId);
  }

  private async getLocalMetadataForSettings(
    integrationId: string,
    accountId?: string,
  ): Promise<BrokerIntegrationMetadataResponse | null> {
    try {
      return await this.getLocalMetadata(integrationId, accountId);
    } catch {
      // Settings/catalog discovery must remain usable before the local vault is
      // configured or unlocked. Never fall back to legacy secret-bearing rows.
      console.warn(`[IntegrationService] Local vault metadata unavailable for ${ integrationId }`);
      return null;
    }
  }

  // ─── Account management ───────────────────────────────────────────

  /** Get the active/default account_id for an integration */
  async getActiveAccountId(integrationId: string): Promise<string> {
    if (usesContainerVaultAuthority()) {
      const metadata = await this.getLocalMetadata(integrationId);
      const accountId = metadata.activeAccountId ?? metadata.accounts[0]?.accountId;
      if (!accountId) throw new Error(`No local vault account is configured for ${ integrationId }`);
      return accountId;
    }
    return IntegrationValueModel.getDefaultAccountId(integrationId);
  }

  /** Set which account is the default for an integration.
   *  Clears is_default on all other accounts, sets it on the target. */
  async setActiveAccount(integrationId: string, accountId: string): Promise<void> {
    if (usesContainerVaultAuthority()) {
      await this.setLocalActiveAccount(integrationId, accountId);
      console.log(`[IntegrationService] Local vault active account for ${ integrationId } set to: ${ accountId }`);
      return;
    }
    await IntegrationValueModel.setDefaultAccount(integrationId, accountId);
    console.log(`[IntegrationService] Default account for ${ integrationId } set to: ${ accountId }`);
  }

  /** Set a human-readable label for an account */
  async setAccountLabel(integrationId: string, accountId: string, label: string): Promise<void> {
    await this.setIntegrationValue({
      integration_id: integrationId,
      account_id:     accountId,
      property:       'account_label',
      value:          label,
    });
  }

  /** Get the label for an account */
  async getAccountLabel(integrationId: string, accountId: string): Promise<string> {
    if (usesContainerVaultAuthority()) {
      const metadata = await this.getLocalMetadataForSettings(integrationId, accountId);
      return metadata?.accounts.find(account => account.accountId === accountId)?.label || accountId;
    }
    const model = await IntegrationValueModel.findByKey(integrationId, accountId, 'account_label');
    return model?.attributes.value || accountId;
  }

  /** List all accounts for an integration */
  async getAccounts(integrationId: string): Promise<IntegrationAccount[]> {
    if (usesContainerVaultAuthority()) {
      const metadata = await this.getLocalMetadataForSettings(integrationId);
      if (!metadata) return [];
      return metadata.accounts.map(account => ({
        integration_id: integrationId,
        account_id:     account.accountId,
        label:          account.label,
        active:         account.active,
        connected:      account.connected,
        connected_at:   account.properties.connected_at ? new Date(account.properties.connected_at) : undefined,
      }));
    }
    const accountIds = await IntegrationValueModel.getDistinctAccounts(integrationId);
    const accounts: IntegrationAccount[] = [];

    for (const accountId of accountIds) {
      const label = await this.getAccountLabel(integrationId, accountId);
      const status = await this.getConnectionStatus(integrationId, accountId);

      // Check is_default from any row for this account
      const accountRows = usesContainerVaultAuthority()
        ? await IntegrationValueModel.findMetadataByAccount(integrationId, accountId)
        : await IntegrationValueModel.findByAccount(integrationId, accountId);
      const isDefault = accountRows.some(m => !!m.attributes.is_default);

      accounts.push({
        integration_id: integrationId,
        account_id:     accountId,
        label,
        active:         isDefault,
        connected:      status.connected,
        connected_at:   status.connected_at,
      });
    }

    return accounts;
  }

  /** Delete an entire account and all its values */
  async deleteAccount(integrationId: string, accountId: string): Promise<boolean> {
    if (usesContainerVaultAuthority()) {
      throw new Error('unsupported_secret_egress: manage local vault accounts in the isolated vault UI');
    }
    const models = await IntegrationValueModel.findByAccount(integrationId, accountId);
    if (models.length === 0) return false;

    const wasDefault = models.some(m => !!m.attributes.is_default);

    for (const model of models) {
      const value = this.modelToValue(model);
      await model.delete();
      this.notifyValueChange(value, 'deleted');
    }

    console.log(`[IntegrationService] Deleted account ${ accountId } for ${ integrationId }`);

    // If the deleted account was the default, assign default to the first remaining account
    if (wasDefault) {
      const remainingAccounts = await IntegrationValueModel.getDistinctAccounts(integrationId);
      if (remainingAccounts.length > 0) {
        await IntegrationValueModel.setDefaultAccount(integrationId, remainingAccounts[0]);
        console.log(`[IntegrationService] Reassigned default to ${ remainingAccounts[0] } for ${ integrationId }`);
      }
    }

    return true;
  }

  // ─── Value CRUD (account-aware) ───────────────────────────────────

  async setIntegrationValue(input: IntegrationValueInput): Promise<IntegrationValue> {
    const integrationId = typeof input.integration_id === 'string' ? input.integration_id.trim() : '';
    const property = typeof input.property === 'string' ? input.property.trim() : '';
    const value = typeof input.value === 'string' ? input.value : String(input.value ?? '');
    if (!integrationId || !property) {
      throw new Error('Integration values require an integration_id and property.');
    }
    if (usesContainerVaultAuthority()) {
      throw new Error('unsupported_secret_egress: edit local vault integration values in the isolated vault UI');
    }

    const accountId = typeof input.account_id === 'string' && input.account_id.trim()
      ? input.account_id.trim()
      : DEFAULT_ACCOUNT_ID;

    // If this is the first account for this integration, auto-mark as default
    const existingAccounts = await IntegrationValueModel.getDistinctAccounts(integrationId);
    const isFirstAccount = existingAccounts.length === 0 || (existingAccounts.length === 1 && existingAccounts[0] === accountId);

    const { model, wasUpdate } = await IntegrationValueModel.upsert(
      integrationId,
      accountId,
      property,
      value,
    );

    // Auto-set default on first account
    if (isFirstAccount && !model.attributes.is_default) {
      await IntegrationValueModel.setDefaultAccount(integrationId, accountId);
    }

    const action = wasUpdate ? 'updated' : 'created';
    console.log(`[IntegrationService] ${ wasUpdate ? 'Updated' : 'Created' } value: ${ integrationId }/${ accountId }.${ property }`);

    const savedValue = this.modelToValue(model);
    this.notifyValueChange(savedValue, action);
    return savedValue;
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
      account_id:     acctId,
      property:       'connection_status',
      value:          connected.toString(),
    });

    if (connected) {
      await this.setIntegrationValue({
        integration_id: integrationId,
        account_id:     acctId,
        property:       'connected_at',
        value:          new Date().toISOString(),
      });
    }

    await this.setIntegrationValue({
      integration_id: integrationId,
      account_id:     acctId,
      property:       'last_sync_at',
      value:          new Date().toISOString(),
    });
  }

  async getConnectionStatus(integrationId: string, accountId?: string): Promise<IntegrationConnectionStatus> {
    if (usesContainerVaultAuthority()) {
      const metadata = await this.getLocalMetadataForSettings(integrationId, accountId);
      const acctId = accountId || metadata?.activeAccountId || metadata?.accounts[0]?.accountId || DEFAULT_ACCOUNT_ID;
      const account = metadata?.accounts.find(candidate => candidate.accountId === acctId);
      return {
        integration_id: integrationId,
        account_id:     acctId,
        connected:      account?.connected === true,
        connected_at:   account?.properties.connected_at ? new Date(account.properties.connected_at) : undefined,
        last_sync_at:   account?.properties.last_sync_at ? new Date(account.properties.last_sync_at) : undefined,
      };
    }

    const acctId = accountId || DEFAULT_ACCOUNT_ID;

    const statusModel = await IntegrationValueModel.findByKey(integrationId, acctId, 'connection_status');
    const connectedAtModel = await IntegrationValueModel.findByKey(integrationId, acctId, 'connected_at');
    const lastSyncModel = await IntegrationValueModel.findByKey(integrationId, acctId, 'last_sync_at');

    return {
      integration_id: integrationId,
      account_id:     acctId,
      connected:      statusModel?.attributes.value === 'true',
      connected_at:   connectedAtModel ? new Date(connectedAtModel.attributes.value!) : undefined,
      last_sync_at:   lastSyncModel ? new Date(lastSyncModel.attributes.value!) : undefined,
    };
  }

  /** Check if ANY account for this integration is connected */
  async isAnyAccountConnected(integrationId: string): Promise<boolean> {
    if (usesContainerVaultAuthority()) {
      return (await this.getAccounts(integrationId)).some(account => account.connected);
    }
    return IntegrationValueModel.existsWithPropertyValue(integrationId, 'connection_status', 'true');
  }

  /** Get all enabled integrations — any integration_id that has at least one account with stored values */
  async getEnabledIntegrations(): Promise<{ integrationId: string; accounts: IntegrationAccount[] }[]> {
    let allIds: string[];
    if (usesContainerVaultAuthority()) {
      // Metadata is queried from the authority, but integration ids are public
      // catalog data. Legacy ids remain only as migration-era discovery hints;
      // their values and connection state are never read here.
      const [{ integrations }, { getIntegrationConfigLoader }] = await Promise.all([
        import('../integrations/catalog'),
        import('../integrations/configApi'),
      ]);
      const loader = getIntegrationConfigLoader();
      await loader.loadAll();
      const hints = await IntegrationValueModel.getDistinctIntegrations().catch(() => []);
      allIds = [...new Set([
        ...Object.keys(integrations),
        ...loader.getAvailableIntegrations(),
        ...hints,
      ])];
    } else {
      allIds = await IntegrationValueModel.getDistinctIntegrations();
    }
    const results: { integrationId: string; accounts: IntegrationAccount[] }[] = [];

    for (const integrationId of allIds) {
      const accounts = await this.getAccounts(integrationId);
      if (accounts.length > 0) {
        results.push({ integrationId, accounts });
      }
    }

    return results;
  }

  // ─── Form values (account-aware) ─────────────────────────────────

  /** Get form values for the active account (or a specific account) */
  async getFormValues(integrationId: string, accountId?: string): Promise<IntegrationValue[]> {
    if (usesContainerVaultAuthority()) {
      // Compatibility callers may still ask for "form" values while building
      // provider clients. Return only routing-safe metadata; credential fields
      // are injected at the final outbound broker hop.
      return this.getMetadataValues(integrationId, accountId);
    }
    const acctId = accountId || await this.getActiveAccountId(integrationId);

    const models = await IntegrationValueModel.getFormValues(integrationId, acctId, SYSTEM_PROPERTIES);

    console.log(`[IntegrationService] Fetched ${ models.length } form values for ${ integrationId }/${ acctId }`);
    return models.map(m => this.modelToValue(m));
  }

  /** Read the non-secret configuration needed to select and route an integration. */
  async getMetadataValues(integrationId: string, accountId?: string): Promise<IntegrationValue[]> {
    if (usesContainerVaultAuthority()) {
      const metadata = await this.getLocalMetadataForSettings(integrationId, accountId);
      if (!metadata) return [];
      const acctId = accountId || metadata.activeAccountId || metadata.accounts[0]?.accountId;
      if (!acctId) return [];
      const account = metadata.accounts.find(candidate => candidate.accountId === acctId);
      if (!account) return [];
      const updatedAt = new Date(0);
      return Object.entries(account.properties).map(([property, value], index) => ({
        value_id:       -(index + 1),
        integration_id: integrationId,
        account_id:     account.accountId,
        property,
        value,
        is_default:     account.active,
        created_at:     updatedAt,
        updated_at:     updatedAt,
      }));
    }
    const acctId = accountId || await this.getActiveAccountId(integrationId);
    const models = await IntegrationValueModel.findMetadataByAccount(integrationId, acctId);
    return models.map(model => this.modelToValue(model));
  }

  async getSerializableFormValues(integrationId: string, accountId: string): Promise<VaultCredentialReadResult> {
    if (usesContainerVaultAuthority()) {
      return {
        success: false,
        error:   {
          code:    'VAULT_DECRYPT_FAILED',
          message: 'unsupported_secret_egress: form credentials are only available inside the local vault UI',
        },
      };
    }
    try {
      const models = await IntegrationValueModel.getFormValues(integrationId, accountId, SYSTEM_PROPERTIES);
      return normalizeVaultCredentialValues(models.map(m => this.modelToValue(m)));
    } catch (error) {
      return {
        success: false,
        error:   {
          code:    'VAULT_DECRYPT_FAILED',
          message: error instanceof Error ? error.message : 'Unable to read vault credential.',
        },
      };
    }
  }

  async setFormValues(inputs: IntegrationValueInput[]): Promise<IntegrationValue[]> {
    const filteredInputs = inputs.filter(input => !SYSTEM_PROPERTIES.includes(input.property));
    return this.setMultipleValues(filteredInputs);
  }

  // ─── Raw value access (account-aware) ─────────────────────────────

  /** Get a value from the active account (backward-compat) */
  async getIntegrationValue(integrationId: string, property: string, accountId?: string): Promise<IntegrationValue | null> {
    if (usesContainerVaultAuthority()) {
      if (!LOCAL_METADATA_PROPERTIES.has(property)) {
        throw new Error('unsupported_secret_egress: use an authenticated outbound vault broker operation');
      }
      const metadata = await this.getMetadataValues(integrationId, accountId);
      return metadata.find(value => value.property === property) ?? null;
    }
    const acctId = accountId || await this.getActiveAccountId(integrationId);
    // Agent/tool execution runs in main and reads the new encrypted vault first.
    // Renderer forms and a missing migrated item keep the legacy store as a
    // read-only fallback during the verified migration window.
    if (typeof process !== 'undefined' && process.type !== 'renderer') {
      const { getDesktopVaultClient } = await import('./DesktopVaultClient');
      const vault = getDesktopVaultClient();
      if (vault.isUnlocked()) {
        const value = await vault.resolveCredential({
          integrationId, accountId: acctId, property, agentId: 'sulla', level: 'autofill',
        });
        if (value !== null) {
          return {
            value_id:       -1,
            integration_id: integrationId,
            account_id:     acctId,
            property,
            value,
            is_default:     false,
            created_at:     new Date(0),
            updated_at:     new Date(0),
          };
        }
      }
    }
    const model = await IntegrationValueModel.findByKey(integrationId, acctId, property);
    return model ? this.modelToValue(model) : null;
  }

  /** Get all values for the active account (backward-compat) */
  async getIntegrationValues(integrationId: string, accountId?: string): Promise<IntegrationValue[]> {
    if (usesContainerVaultAuthority()) {
      return this.getMetadataValues(integrationId, accountId);
    }
    const acctId = accountId || await this.getActiveAccountId(integrationId);
    const models = await IntegrationValueModel.findByAccount(integrationId, acctId);
    return models.map(m => this.modelToValue(m));
  }

  async getAllIntegrationValues(): Promise<IntegrationValue[]> {
    if (usesContainerVaultAuthority()) {
      throw new Error('unsupported_secret_egress: bulk integration values are unavailable outside the vault');
    }
    const models = await IntegrationValueModel.all();
    console.log(`[IntegrationService] Fetched ${ models.length } total values`);
    return models.map(m => this.modelToValue(m));
  }

  // ─── Delete (account-aware) ───────────────────────────────────────

  async deleteIntegrationValue(integrationId: string, property: string, accountId?: string): Promise<boolean> {
    if (usesContainerVaultAuthority()) {
      throw new Error('unsupported_secret_egress: manage local vault integration values in the isolated vault UI');
    }
    const acctId = accountId || await this.getActiveAccountId(integrationId);

    const model = await IntegrationValueModel.findByKey(integrationId, acctId, property);
    if (!model) return false;

    const value = this.modelToValue(model);
    await model.delete();
    console.log(`[IntegrationService] Deleted value: ${ integrationId }/${ acctId }.${ property }`);
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
    if (usesContainerVaultAuthority()) {
      throw new Error('unsupported_secret_egress: manage local vault integration accounts in the isolated vault UI');
    }
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

    console.log(`[IntegrationService] Deleted ${ models.length } values for ${ integrationId }`);
    return true;
  }
}
