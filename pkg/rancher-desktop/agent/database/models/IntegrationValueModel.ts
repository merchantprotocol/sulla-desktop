import { BaseModel } from '../BaseModel';

const VAULT_PREFIX = '$VAULT$';
const isRenderer = typeof process !== 'undefined' && process.type === 'renderer';

/**
 * Get the VaultKeyService for encrypt/decrypt.
 * In the main process: direct access.
 * In the renderer: returns null (uses IPC fallback below).
 */
function getVaultDirect() {
  if (isRenderer) return null;
  try {
    const { getVaultKeyService } = require('../../services/VaultKeyService');
    return getVaultKeyService();
  } catch { return null }
}

/**
 * Synchronous decrypt/encrypt via IPC (renderer only).
 * Uses sendSync for synchronous model attribute access.
 */
function ipcDecrypt(value: string): string {
  if (!isRenderer || !value.startsWith(VAULT_PREFIX)) return value;
  try {
    const { ipcRenderer } = require('electron');
    const result = ipcRenderer.sendSync('vault:decrypt-sync', value);
    return result || value;
  } catch { return value }
}

function ipcEncrypt(value: string): string {
  if (!isRenderer) return value;
  try {
    const { ipcRenderer } = require('electron');
    const result = ipcRenderer.sendSync('vault:encrypt-sync', value);
    return result || value;
  } catch { return value }
}

interface IntegrationValueAttributes {
  value_id:       number;
  integration_id: string;
  account_id:     string;
  property:       string;
  value:          string;
  is_default:     boolean;
  created_at:     Date;
  updated_at:     Date;
}

export class IntegrationValueModel extends BaseModel<IntegrationValueAttributes> {
  protected readonly tableName = 'integration_values';
  protected readonly primaryKey = 'value_id';
  protected readonly timestamps = true;

  protected readonly fillable = [
    'integration_id',
    'account_id',
    'property',
    'value',
    'is_default',
  ];

  protected readonly casts: Record<string, string> = {
    value_id:   'integer',
    is_default: 'boolean',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  };

  constructor(attributes: Partial<IntegrationValueAttributes> = {}) {
    super();
    this.attributes = { ...attributes };
    this.original = { ...attributes };
  }

  // ─── Vault encryption helpers ──────────────────────────────────────

  /** Encrypt a value if the vault is available, otherwise return as-is */
  private static encryptValue(value: string): string {
    // Main process: direct
    const vault = getVaultDirect();
    if (vault?.isUnlocked()) {
      try { return vault.encrypt(value) } catch { /* fall through */ }
    }
    // Renderer: IPC
    if (isRenderer) {
      try { return ipcEncrypt(value) } catch { /* fall through */ }
    }
    return value;
  }

  /** Decrypt a value if it's vault-encrypted, otherwise return as-is */
  private static decryptValue(value: string): string {
    if (!value?.startsWith(VAULT_PREFIX)) return value;
    // Main process: direct
    const vault = getVaultDirect();
    if (vault) {
      try {
        return vault.decrypt(value);
      } catch (err) {
        console.error('[IntegrationValueModel] Vault decrypt failed (vault locked?):', err);
      }
    }
    // Renderer: IPC
    if (isRenderer) {
      try {
        return ipcDecrypt(value);
      } catch (err) {
        console.error('[IntegrationValueModel] IPC decrypt failed:', err);
      }
    }
    console.warn('[IntegrationValueModel] Returning encrypted value as-is — vault may be locked');
    return value;
  }

  /** Decrypt the value attribute on a model instance */
  private static decryptModel(model: IntegrationValueModel): IntegrationValueModel {
    if (model.attributes.value) {
      model.attributes.value = this.decryptValue(model.attributes.value);
    }
    return model;
  }

  /** Decrypt value attributes on an array of models */
  private static decryptModels(models: IntegrationValueModel[]): IntegrationValueModel[] {
    return models.map(m => this.decryptModel(m));
  }

  /**
   * Encrypt all unencrypted values in the database.
   * Safe to call multiple times — skips already-encrypted rows.
   */
  static async migrateToEncrypted(): Promise<number> {
    const vault = getVaultDirect();
    if (!vault?.isUnlocked()) {
      console.log('[IntegrationValueModel] Vault locked — skipping encryption migration');
      return 0;
    }

    const allRows = await this.query(
      `SELECT "value_id", "value" FROM "integration_values" WHERE "value" NOT LIKE '$VAULT$%'`,
      [],
    );

    let count = 0;
    for (const row of allRows) {
      if (row.value && !vault.isEncrypted(row.value as string)) {
        const encrypted = vault.encrypt(row.value as string);
        await this.query(
          `UPDATE "integration_values" SET "value" = $1, "updated_at" = CURRENT_TIMESTAMP WHERE "value_id" = $2`,
          [encrypted, row.value_id],
        );
        count++;
      }
    }

    if (count > 0) {
      console.log(`[IntegrationValueModel] Encrypted ${ count } plain-text values`);
    }
    return count;
  }

  /**
   * Re-encrypt all vault-encrypted values from an old key to the current key.
   * Called during password change to migrate credentials to the new VMK.
   */
  static async reEncryptAll(oldDecrypt: (v: string) => string): Promise<number> {
    const vault = getVaultDirect();
    if (!vault?.isUnlocked()) {
      console.error('[IntegrationValueModel] New vault not unlocked — cannot re-encrypt');
      return 0;
    }

    const allRows = await this.query(
      `SELECT "value_id", "value" FROM "integration_values" WHERE "value" LIKE '$VAULT$%'`,
      [],
    );

    let count = 0;
    let failed = 0;
    for (const row of allRows) {
      try {
        const plaintext = oldDecrypt(row.value as string);
        const reEncrypted = vault.encrypt(plaintext);
        await this.query(
          `UPDATE "integration_values" SET "value" = $1, "updated_at" = CURRENT_TIMESTAMP WHERE "value_id" = $2`,
          [reEncrypted, row.value_id],
        );
        count++;
      } catch (err) {
        failed++;
        console.error(`[IntegrationValueModel] Failed to re-encrypt value_id=${ row.value_id }:`, err);
      }
    }

    console.log(`[IntegrationValueModel] Re-encrypted ${ count } values (${ failed } failed)`);
    return count;
  }

  // ─── Static finders ────────────────────────────────────────────────

  /** Find a single value by composite key */
  static async findByKey(
    integrationId: string,
    accountId: string,
    property: string,
  ): Promise<IntegrationValueModel | null> {
    const rows = await this.where({
      integration_id: integrationId,
      account_id:     accountId,
      property,
    });
    const model = rows[0] || null;
    return model ? this.decryptModel(model) : null;
  }

  /** Find all values for an integration + account */
  static async findByAccount(
    integrationId: string,
    accountId: string,
  ): Promise<IntegrationValueModel[]> {
    const models = await this.where({
      integration_id: integrationId,
      account_id:     accountId,
    });
    return this.decryptModels(models);
  }

  /** Find all values for an integration across all accounts */
  static async findByIntegration(
    integrationId: string,
  ): Promise<IntegrationValueModel[]> {
    const models = await this.where({ integration_id: integrationId });
    return this.decryptModels(models);
  }

  /** Get all distinct integration_ids that have stored values */
  static async getDistinctIntegrations(): Promise<string[]> {
    const rows = await this.query(
      `SELECT DISTINCT "integration_id" FROM "integration_values" ORDER BY "integration_id"`,
      [],
    );
    return rows.map(r => r.integration_id as string);
  }

  /** Get distinct account_ids for an integration */
  static async getDistinctAccounts(integrationId: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT DISTINCT "account_id" FROM "integration_values" WHERE "integration_id" = $1 ORDER BY "account_id"`,
      [integrationId],
    );
    return rows.map(r => r.account_id as string);
  }

  /** Check if any row matches integration + property value (handles encrypted values) */
  static async existsWithPropertyValue(
    integrationId: string,
    property: string,
    value: string,
  ): Promise<boolean> {
    // First try exact match (works for unencrypted or if caller passes encrypted value)
    const rows = await this.query(
      `SELECT 1 FROM "integration_values" WHERE "integration_id" = $1 AND "property" = $2 AND "value" = $3 LIMIT 1`,
      [integrationId, property, value],
    );
    if (rows.length > 0) return true;

    // If values are encrypted, we need to decrypt and compare
    const allRows = await this.query(
      `SELECT "value" FROM "integration_values" WHERE "integration_id" = $1 AND "property" = $2`,
      [integrationId, property],
    );
    return allRows.some(r => this.decryptValue(r.value as string) === value);
  }

  /** Upsert a value: update if exists, insert if not. Encrypts at rest. Returns the model + whether it was an update. */
  static async upsert(
    integrationId: string,
    accountId: string,
    property: string,
    value: string,
  ): Promise<{ model: IntegrationValueModel; wasUpdate: boolean }> {
    const encryptedValue = this.encryptValue(value);

    // findByKey decrypts — we need the raw row to check existence without double-decrypt
    const rawRows = await this.where({
      integration_id: integrationId,
      account_id:     accountId,
      property,
    });
    const existing = rawRows[0] || null;

    if (existing) {
      existing.attributes.value = encryptedValue;
      await existing.save();
      // Return with decrypted value for callers
      existing.attributes.value = value;
      return { model: existing, wasUpdate: true };
    }

    const model = await this.create({
      integration_id: integrationId,
      account_id:     accountId,
      property,
      value:          encryptedValue,
    });
    // Return with decrypted value for callers
    model.attributes.value = value;
    return { model, wasUpdate: false };
  }

  /** Delete all values for an integration + account */
  static async deleteByAccount(integrationId: string, accountId: string): Promise<number> {
    const rows = await this.findByAccount(integrationId, accountId);
    let count = 0;
    for (const row of rows) {
      if (await row.delete()) count++;
    }
    return count;
  }

  /** Delete all values for an integration across all accounts */
  static async deleteByIntegration(integrationId: string): Promise<number> {
    const rows = await this.findByIntegration(integrationId);
    let count = 0;
    for (const row of rows) {
      if (await row.delete()) count++;
    }
    return count;
  }

  /** Get form values (exclude system properties) for an account */
  static async getFormValues(
    integrationId: string,
    accountId: string,
    systemProperties: string[],
  ): Promise<IntegrationValueModel[]> {
    const all = await this.findByAccount(integrationId, accountId);
    return all.filter(m => !systemProperties.includes(m.attributes.property!));
  }

  /** Get the default account_id for an integration. Returns 'default' if none marked. */
  static async getDefaultAccountId(integrationId: string): Promise<string> {
    try {
      const rows = await this.query(
        `SELECT DISTINCT "account_id" FROM "integration_values"
         WHERE "integration_id" = $1 AND "is_default" = TRUE
         LIMIT 1`,
        [integrationId],
      );
      if (rows[0]?.account_id) {
        return rows[0].account_id as string;
      }
    } catch (error: any) {
      // Backward-compat for databases that haven't applied 0014 yet.
      if (error?.code !== '42703') {
        throw error;
      }

      const legacyRows = await this.query(
        `SELECT "value" FROM "integration_values"
         WHERE "integration_id" = $1 AND "account_id" = 'default' AND "property" = 'active_account'
         LIMIT 1`,
        [integrationId],
      );
      if (legacyRows[0]?.value) {
        return legacyRows[0].value as string;
      }
    }

    const fallbackRows = await this.query(
      `SELECT DISTINCT "account_id" FROM "integration_values"
       WHERE "integration_id" = $1
       ORDER BY "account_id" ASC
       LIMIT 1`,
      [integrationId],
    );
    return (fallbackRows[0]?.account_id as string) || 'default';
  }

  /**
   * Set an account as the default for an integration.
   * Clears is_default on all other accounts for that integration,
   * then sets is_default=TRUE on all rows for the target account.
   */
  static async setDefaultAccount(integrationId: string, accountId: string): Promise<void> {
    try {
      // Clear default from all accounts for this integration
      await this.query(
        `UPDATE "integration_values" SET "is_default" = FALSE, "updated_at" = CURRENT_TIMESTAMP
         WHERE "integration_id" = $1 AND "is_default" = TRUE`,
        [integrationId],
      );
      // Set default on the target account
      await this.query(
        `UPDATE "integration_values" SET "is_default" = TRUE, "updated_at" = CURRENT_TIMESTAMP
         WHERE "integration_id" = $1 AND "account_id" = $2`,
        [integrationId, accountId],
      );
      return;
    } catch (error: any) {
      // Backward-compat for databases that haven't applied 0014 yet.
      if (error?.code !== '42703') {
        throw error;
      }
    }

    // Legacy fallback: keep old active_account marker so behavior remains functional
    // until migrations run.
    await this.upsert(integrationId, 'default', 'active_account', accountId);
  }
}
