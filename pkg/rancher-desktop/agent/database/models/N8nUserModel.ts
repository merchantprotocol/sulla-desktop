// src/models/N8nUserModel.ts

import { BaseModel } from '../BaseModel';
import { SullaSettingsModel } from './SullaSettingsModel';

interface N8nUserAttributes {
  id:                     string;
  email:                  string;
  firstName:              string;
  lastName:               string;
  password:               string;
  personalizationAnswers: any;
  createdAt:              Date;
  updatedAt:              Date;
  settings:               any;
  disabled:               boolean;
  mfaEnabled:             boolean;
  mfaSecret:              string;
  mfaRecoveryCodes:       string;
  lastActiveAt:           Date;
  roleSlug:               string;
}

export class N8nUserModel extends BaseModel<N8nUserAttributes> {
  protected readonly tableName = 'user';
  protected readonly primaryKey = 'id';
  protected readonly timestamps = false; // n8n user table doesn't have created_at/updated_at columns

  protected readonly fillable = [
    'email',
    'firstName',
    'lastName',
    'password',
    'personalizationAnswers',
    'settings',
    'disabled',
    'mfaEnabled',
    'mfaSecret',
    'mfaRecoveryCodes',
    'lastActiveAt',
    'roleSlug',
  ];

  /**
   * Define casting rules for automatic type conversion
   */
  protected readonly casts: Record<string, string> = {
    personalizationAnswers: 'json',
    settings:               'json',
    lastActiveAt:           'timestamp',
    disabled:               'boolean',
    mfaEnabled:             'boolean',
  };

  public static async getOrCreateServiceAccount(): Promise<N8nUserModel> {
    const serviceAccountId = await this.getServiceAccountUserId() || '';
    console.log('[N8NUserModel] serviceAccountId :' + serviceAccountId);
    let user;

    if (serviceAccountId) {
      user = await N8nUserModel.load(serviceAccountId);
    }

    if (!user) {
      const serviceAccountEmail = await this.getServiceAccountEmail();
      console.log('[N8NUserModel] trying to load by email:', serviceAccountEmail);
      const users = await N8nUserModel.where('email', serviceAccountEmail);
      user = users.length > 0 ? users[0] : null;
    }

    if (!user) {
      console.log('[N8NUserModel] creating new service account');
      user = new N8nUserModel();
      user.attributes.id = serviceAccountId;
      user.attributes.email = await N8nUserModel.getServiceAccountEmail();
      user.attributes.firstName = 'Sulla';
      user.attributes.lastName = 'Desktop';
      user.attributes.personalizationAnswers = {};
      user.attributes.settings = { userActivated: true };
      user.attributes.disabled = false;
      user.attributes.mfaEnabled = false;
      user.attributes.mfaSecret = '';
      user.attributes.mfaRecoveryCodes = '';
      user.attributes.lastActiveAt = new Date();
      user.attributes.roleSlug = 'global:owner';
      await user.setPassword(await N8nUserModel.getServiceAccountPassword());
      await user.save();

      await SullaSettingsModel.set('serviceAccountUserId', user.attributes.id, 'string');
      console.log('[N8nUserModel] Settings saved:', user.attributes.id);
    }
    return user;
  }

  /**
   * Get the service account user ID from settings
   */
  public static async getServiceAccountUserId(): Promise<string | null> {
    return await SullaSettingsModel.get('serviceAccountUserId', null);
  }

  /**
   *
   * @returns
   */
  public static async getServiceAccountEmail(): Promise<string> {
    // Get user registration details from SullaSettingsModel
    const userEmail = await SullaSettingsModel.get('sullaEmail');

    if (!userEmail) {
      console.log('[N8nUserSeeder] No user email found in settings, skipping...');
      return 'info@sulladesktop.com';
    }

    return userEmail || 'info@sulladesktop.com';
  }

  /**
   *
   * @returns
   */
  public static async getServiceAccountPassword(): Promise<string> {
    // Get user registration details from SullaSettingsModel
    const userPassword = await SullaSettingsModel.get('sullaPassword');

    if (!userPassword) {
      console.log('[N8nUserSeeder] No user password found in settings, skipping...');
      return 'n8n_dev_password';
    }

    return userPassword;
  }

  /**
   * Get the user ID (public accessor for cross-model access)
   */
  public getId(): string {
    return this.attributes.id!;
  }

  /**
   * Set the user's password with proper bcrypt hashing
   * @param plainPassword - The plain text password to hash
   */
  async setPassword(plainPassword: string): Promise<void> {
    const bcrypt = await import('bcryptjs');
    this.attributes.password = await bcrypt.hash(plainPassword, 10);
  }

  /**
   * Override find to only allow finding the service account user
   */
  static async load<T extends BaseModel>(this: new (...args: any[]) => T, id: string | number): Promise<T | null> {
    const serviceAccountId = await N8nUserModel.getServiceAccountUserId();
    if (!serviceAccountId || id !== serviceAccountId) {
      console.warn('[N8nUserModel] Access denied: can only access service account user');
      return null;
    }

    return super.find.call(this, id) as Promise<T | null>;
  }

  /**
   * Override where to only return the service account user
   */
  static async where<T extends BaseModel>(
    this: new (...args: any[]) => T,
    conditions: any,
    value?: any,
  ): Promise<T[]> {
    const serviceAccountId = await N8nUserModel.getServiceAccountUserId();
    if (!serviceAccountId) {
      console.warn('[N8nUserModel] No service account user ID configured');
      return [];
    }

    // Always filter by service account ID
    const filteredConditions = { id: serviceAccountId };

    return super.where.call(this, filteredConditions) as Promise<T[]>;
  }
}
