import { BaseModel } from '../BaseModel';
import { SullaSettingsModel } from './SullaSettingsModel';
import * as crypto from 'crypto';

/**
 * Maps integration slugs to their corresponding n8n credential type identifiers.
 * Falls back to `${slug}Api` for unmapped integrations.
 */
const N8N_CREDENTIAL_TYPE_MAP: Record<string, string> = {
  slack:     'slackApi',
  github:    'githubApi',
  gmail:     'gmailOAuth2Api',
  discord:   'discordApi',
  telegram:  'telegramApi',
  openai:    'openAiApi',
  anthropic: 'anthropicApi',
  grok:      'grokApi',
};

export class N8nCredentialsEntityModel extends BaseModel {
  protected readonly tableName = 'credentials_entity';

  protected readonly fillable = [
    'id',
    'name',
    'data',
    'type',
    'isManaged',
    'isGlobal',
    'isResolvable',
    'resolvableAllowFallback',
    'resolverId',
  ];

  // n8n credentials_entity uses camelCase timestamps (createdAt/updatedAt),
  // not snake_case created_at/updated_at expected by BaseModel timestamps.
  protected readonly timestamps = false;

  async save(): Promise<this> {
    if (!this.attributes.id) {
      this.attributes.id = SullaSettingsModel.generateId();
    }
    return super.save();
  }

  // CryptoJS 'Salted__' magic bytes — n8n uses CryptoJS-compatible encryption
  private static readonly SALT_PREFIX = Buffer.from('53616c7465645f5f', 'hex');

  /**
   * Derive AES-256-CBC key + IV from password + salt using the CryptoJS-compatible
   * EVP_BytesToKey (MD5) algorithm. This matches n8n's Cipher.getKeyAndIv().
   */
  private static getKeyAndIv(salt: Buffer, encryptionKey: string): [Buffer, Buffer] {
    const password = Buffer.concat([Buffer.from(encryptionKey, 'binary'), salt]);
    const hash1 = crypto.createHash('md5').update(password).digest();
    const hash2 = crypto.createHash('md5').update(Buffer.concat([hash1, password])).digest();
    const iv = crypto.createHash('md5').update(Buffer.concat([hash2, password])).digest();
    const key = Buffer.concat([hash1, hash2]);
    return [key, iv];
  }

  /**
   * Encrypt a credential data object using n8n's AES-256-CBC encryption
   * (CryptoJS-compatible format) and set it on the `data` attribute.
   * @param credential - Plain object of credential key/value pairs
   */
  async encryptData(credential: Record<string, any>): Promise<void> {
    const encryptionKey = await SullaSettingsModel.get('sullaN8nEncryptionKey');
    if (!encryptionKey) {
      throw new Error('No encryption key found in settings');
    }

    const salt = crypto.randomBytes(8);
    const [key, iv] = N8nCredentialsEntityModel.getKeyAndIv(salt, encryptionKey);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = cipher.update(JSON.stringify(credential), 'utf8');

    this.attributes.data = Buffer.concat([
      N8nCredentialsEntityModel.SALT_PREFIX,
      salt,
      encrypted,
      cipher.final(),
    ]).toString('base64');
  }

  /**
   * Transfer credentials from IntegrationService into n8n's credentials_entity table.
   * Looks up the integration by slug, reads form values from the active account,
   * encrypts them, and upserts the corresponding credentials_entity row.
   *
   * @param integrationSlug - The integration id (e.g. 'slack', 'github')
   * @returns The saved N8nCredentialsEntityModel instance
   */
  static async transferCredentials(integrationSlug: string): Promise<N8nCredentialsEntityModel> {
    const { getIntegrationService } = await import('../../services/IntegrationService');
    const { integrations } = await import('../../integrations/catalog');

    const service = getIntegrationService();
    await service.initialize();

    const catalogEntry = integrations[integrationSlug];
    if (!catalogEntry) {
      throw new Error(`Integration "${ integrationSlug }" not found in catalog`);
    }

    // Build credential data from integration form values
    const formValues = await service.getFormValues(integrationSlug);
    const credentialData: Record<string, string> = {};
    for (const fv of formValues) {
      credentialData[fv.property] = fv.value;
    }

    if (Object.keys(credentialData).length === 0) {
      throw new Error(`No credentials found for integration "${ integrationSlug }"`);
    }

    // n8n credential type mapping
    const n8nType = N8N_CREDENTIAL_TYPE_MAP[integrationSlug] || `${ integrationSlug }Api`;

    // Find existing credential by type or create new
    const existing = await N8nCredentialsEntityModel.where<N8nCredentialsEntityModel>('type', n8nType);
    let model: N8nCredentialsEntityModel;

    if (existing.length > 0) {
      model = existing[0];
    } else {
      model = new N8nCredentialsEntityModel();
      model.fill({
        name: catalogEntry.name,
        type: n8nType,
      });
    }

    await model.encryptData(credentialData);
    await model.save();

    console.log(`[N8nCredentialsEntityModel] Transferred credentials for ${ integrationSlug } → ${ n8nType } (id: ${ model.attributes.id })`);
    return model;
  }

  /**
   * Decrypt the credential data using n8n's AES-256-CBC encryption
   * (CryptoJS-compatible format).
   * @returns Decrypted credential data object
   */
  async decryptData(): Promise<any> {
    const encryptedData = this.attributes.data;
    if (!encryptedData) {
      throw new Error('No encrypted data found');
    }

    const encryptionKey = await SullaSettingsModel.get('sullaN8nEncryptionKey');
    if (!encryptionKey) {
      throw new Error('No encryption key found in settings');
    }

    const input = Buffer.from(encryptedData, 'base64');
    if (input.length < 16) {
      throw new Error('Encrypted data too short');
    }

    // Bytes 0-7: 'Salted__' prefix, bytes 8-15: salt, rest: ciphertext
    const salt = input.subarray(8, 16);
    const contents = input.subarray(16);
    const [key, iv] = N8nCredentialsEntityModel.getKeyAndIv(salt, encryptionKey);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(contents), decipher.final()]).toString('utf-8');

    return JSON.parse(decrypted);
  }
}
