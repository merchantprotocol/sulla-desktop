// src/models/SullaSettingsModel.ts

import crypto from 'crypto';
import * as fs from 'fs/promises';

import { BaseModel } from '../BaseModel';
import { redisClient } from '../RedisClient';

interface SettingsAttributes {
  property: string;
  value:    any;
  cast?:    string;
}

// ──────────────────────────────────────────────
// IPC Proxy: renderer processes delegate to main
// ──────────────────────────────────────────────

function isRendererProcess(): boolean {
  try {
    return typeof process !== 'undefined' && process.type === 'renderer';
  } catch {
    return false;
  }
}

let _ipcRenderer: any = null;

function getIpcRenderer(): any {
  if (!_ipcRenderer) {
    _ipcRenderer = require('electron').ipcRenderer;
  }
  return _ipcRenderer;
}

export class SullaSettingsModel extends BaseModel<SettingsAttributes> {
  protected readonly tableName = 'sulla_settings';
  protected get tableRef(): string {
    return 'sulla_settings';
  }

  protected primaryKey = 'property';
  protected fillable: string[] = ['property', 'value', 'cast'];
  protected guarded:  string[] = [];
  protected timestamps = false;

  /**
   * Define casting rules for automatic type conversion
   */
  protected readonly casts: Record<string, string> = {
    value: 'string',
  };

  /**
   * Convert value to string based on cast type
   */
  private static toStringValue(value: any, cast: string): string {
    switch (cast) {
    case 'string':
    case 'slug':
      return String(value);
    case 'number':
      return String(value);
    case 'boolean':
      return String(value);
    case 'array':
    case 'json':
      return JSON.stringify(value);
    default:
      // For uncast values, treat as plain string (don't JSON stringify)
      return value;
    }
  }

  /**
   * Cast value back from string based on cast type
   */
  private static castValue(value: string, cast?: string): any {
    try {
      switch (cast) {
      case 'string':
      case 'slug':
        return value;
      case 'number':
        return Number(value);
      case 'boolean':
        const cleaned = value.toLowerCase();
        const truthyValues = ['true', '1', 'yes', 'on'];
        return truthyValues.includes(cleaned);
      case 'array':
      case 'json':
        return JSON.parse(value);
      default:
        // For uncast values, return as-is
        return value;
      }
    } catch (err) {
      console.error('Error casting value:', err);
      return value;
    }
  }

  // ──────────────────────────────────────────────
  // Persistent installation file path (decided once per process)
  // ──────────────────────────────────────────────

  // without this file, the system will demand to be installed again and again
  protected static installationLockFile: string | null = null;

  /** Returns the same fallback file path for the entire process lifetime */
  public static getFallbackFilePath(): string {
    if (SullaSettingsModel.installationLockFile) {
      return SullaSettingsModel.installationLockFile;
    }
    throw new Error('Fallback path not set');
  }

  public static setFallbackFilePath(path: string): void {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('Invalid path: must be a non-empty string');
    }
    SullaSettingsModel.installationLockFile = path.trim();
  }

  // ──────────────────────────────────────────────
  // Bootstrap / Offline-First Fallback Layer
  // ──────────────────────────────────────────────

  private static isReady = false;

  // ──────────────────────────────────────────────
  // Bootstrap: sync fallback → real backends
  // Call once after PG + Redis are confirmed ready
  // ──────────────────────────────────────────────

  /**
   * Full bootstrap: call when DBs are ready
   *
   * @returns
   */
  public static async bootstrap(): Promise<void> {
    if (this.isReady) return;
    if (!this.installationLockFile) {
      throw new Error('Installation lock file not set for bootstrap');
    }

    try {
      console.log('SullaSettingsModel: full bootstrap starting');

      // PG → Redis
      // now that the system is ready we can write to persistent storage
      await this.initialize();
      this.isReady = true;

      if (!(await this.getSetting('sullaInstalled', false))) {
        // Read from installation lock file and sync to persistent storage
        try {
          const content = await fs.readFile(this.getFallbackFilePath(), 'utf8');
          const data = JSON.parse(content) as Record<string, any>;
          for (const [property, value] of Object.entries(data)) {
            await this.setSetting(property, value);
          }
          console.log(`SullaSettingsModel: synced ${ Object.keys(data).length } settings from lock file`);
        } catch (err) {
          console.log('SullaSettingsModel: no lock file to sync or error reading:', err);
        }

        await this.setSetting('sullaInstalled', true, 'boolean');

        // do not delete the fallback file. it acts as our installation lock file
        console.log('SullaSettingsModel: full bootstrap complete');
      }
    } catch (err) {
      console.error('SullaSettingsModel: bootstrap is not ready yet. Try again later');
    }
  }

  // ──────────────────────────────────────────────
  // Sync PG → Redis on startup or after bootstrap
  // ──────────────────────────────────────────────

  /**
   * Sync all settings from PostgreSQL to Redis
   * @returns
   */
  public static async initialize(): Promise<void> {
    try {
      const pipeline = redisClient.pipeline();

      const all = await this.all();
      console.log('SullaSettingsModel: initializing with', all.length, 'settings');
      if (all.length === 0) return;
      for (const setting of all) {
        const property = setting.attributes.property!;
        const value = setting.attributes.value;
        pipeline.hset('sulla_settings', property, String(value));
      }
      await pipeline.exec();
    } catch (error) {
      throw new Error(`Failed to initialize settings in Redis: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }

  // ──────────────────────────────────────────────
  // Core Get / Set with fallback → redis → pg
  // ──────────────────────────────────────────────

  /**
   *
   * @param property
   * @param _default
   * @returns
   */
  public static async getSetting(property: string, _default: any = null): Promise<any> {
    if (this.isReady) {
      // Redis → PG path (values are strings)
      const cached = await redisClient.hget('sulla_settings', property);
      if (cached !== null) {
        // Get cast from DB since Redis doesn't store it
        const setting = await this.find(property);
        if (setting) {
          const cast = setting.attributes.cast;
          return this.castValue(cached, cast);
        }
        return this.castValue(cached); // fallback without cast
      }
      const setting = await this.find(property);
      if (setting) {
        const value = setting.attributes.value;
        const cast = setting.attributes.cast;
        await redisClient.hset('sulla_settings', property, value);
        return this.castValue(value, cast);
      }
      return _default;
    }

    // Fallback: always read fresh from disk
    const filePath = this.getFallbackFilePath();
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(content) as Record<string, any>;
      return property in data ? data[property] : _default;
    } catch (err) {
      // File missing or invalid — return default silently
      return _default;
    }
  }

  /**
   *
   * @param property
   * @param value
   * @returns
   */
  public static async setSetting(property: string, value: any, cast?: string): Promise<void> {
    const valueCast = cast || typeof value;
    const stringValue = this.toStringValue(value, valueCast);

    if (this.isReady) {
      // Write-through to PG + Redis (unchanged)
      const existing = await this.find(property);
      if (existing) {
        existing.attributes.value = stringValue;
        existing.attributes.cast = cast;
        await existing.save();
      } else {
        const model = new this();
        model.attributes = { property, value: stringValue, cast };
        await model.save();
      }
      await redisClient.hset('sulla_settings', property, stringValue);
      return;
    }

    // Fallback: read-modify-write JSON file
    const filePath = this.getFallbackFilePath();
    console.log(`[SullaSettingsModel] Fallback path set to: ${ filePath }`);
    let data: Record<string, any> = {};
    try {
      const content = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(content);
    } catch {} // file missing → start empty

    data[property] = value;

    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Public API — renderer processes proxy through IPC to main
   */
  public static async get(property: string, defaultValue: any = null): Promise<any> {
    if (isRendererProcess()) {
      return getIpcRenderer().invoke('sulla-settings-get', property, defaultValue);
    }
    return this.getSetting(property, defaultValue);
  }

  /**
   * Public API — renderer processes proxy through IPC to main
   */
  public static async set(property: string, value: any, cast?: string): Promise<void> {
    if (isRendererProcess()) {
      return getIpcRenderer().invoke('sulla-settings-set', property, value, cast);
    }
    return this.setSetting(property, value, cast);
  }

  // ──────────────────────────────────────────────
  // Utils
  // ──────────────────────────────────────────────

  public static async delete(property: string): Promise<void> {
    if (isRendererProcess()) {
      return getIpcRenderer().invoke('sulla-settings-delete', property);
    }
    if (!this.isReady) {
      const filePath = this.getFallbackFilePath();
      let data: Record<string, any> = {};
      try {
        const content = await fs.readFile(filePath, 'utf8');
        data = JSON.parse(content);
      } catch {} // file missing → do nothing
      delete data[property];
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      return;
    }

    const model = new this();
    model.attributes.property = property;
    await model.delete();
    await redisClient.hdel('sulla_settings', property);
  }

  public static generatePassword(length = 16): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+';
    return Array.from(crypto.randomBytes(length))
      .map(b => chars[b % chars.length])
      .join('');
  }

  public static generateEncryptionKey(length = 32): string {
    return crypto.randomBytes(length).toString('base64');
  }

  public static generateId(): string {
    return crypto.randomUUID();
  }

  /**
   * Generate an n8n-compatible API key ID (16 alphanumeric chars)
   */
  public static generateN8nApiKeyId(): string {
    return crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
  }

  /**
   * Generate an n8n-compatible JWT API key token.
   * Uses the same signing secret as n8n's N8N_USER_MANAGEMENT_JWT_SECRET.
   *
   * @param userId - The n8n user UUID to embed as `sub` claim
   * @param encryptionKey - The sullaN8nEncryptionKey (JWT signing secret)
   */
  public static async generateN8nApiKeyToken(userId: string, encryptionKey: string): Promise<string> {
    const jwt = await import('jsonwebtoken');

    const payload = {
      sub: userId,
      iss: 'n8n',
      aud: 'public-api',
      jti: crypto.randomBytes(16).toString('hex'),
      iat: Math.floor(Date.now() / 1000),
    };

    return jwt.default.sign(payload, encryptionKey);
  }

  // ──────────────────────────────────────────────
  // Pattern-based querying for active plans
  // ──────────────────────────────────────────────

  /**
   * Get all settings matching a key pattern
   * Pattern examples: 'active_plan:*', 'active_plan:thread_123:*'
   */
  public static async getByPattern(pattern: string): Promise<Record<string, any>> {
    if (this.isReady) {
      // Redis pattern scanning
      const keys = await redisClient.scan('0', 'MATCH', pattern.replace(':', '_'), 'COUNT', '1000');
      if (keys[1].length > 0) {
        const values = await redisClient.hmget('sulla_settings', ...keys[1]);
        const result: Record<string, any> = {};

        for (let i = 0; i < keys[1].length; i++) {
          const key = keys[1][i];
          const value = values[i];
          if (value !== null) {
            // Get cast info from database
            const setting = await this.find(key);
            const cast = setting?.attributes.cast;
            result[key] = this.castValue(value, cast);
          }
        }
        return result;
      }

      // Fallback to PostgreSQL pattern matching
      try {
        const settings = await this.query(`
          SELECT property, value, "cast"
          FROM sulla_settings
          WHERE property LIKE $1
        `, [pattern.replace('*', '%')]);

        const result: Record<string, any> = {};
        for (const setting of settings) {
          result[setting.property] = this.castValue(setting.value, setting.cast);
        }
        return result;
      } catch (error) {
        console.error('PostgreSQL pattern query failed:', error);
        return {};
      }
    }

    // File fallback - load entire file and filter
    try {
      const filePath = this.getFallbackFilePath();
      const content = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(content) as Record<string, any>;

      const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
      const result: Record<string, any> = {};

      for (const [key, value] of Object.entries(data)) {
        if (regex.test(key)) {
          result[key] = value;
        }
      }

      return result;
    } catch (error) {
      console.warn('File pattern query failed:', error);
      return {};
    }
  }

  /**
   * Delete all settings matching a pattern
   */
  public static async deleteByPattern(pattern: string): Promise<number> {
    const matches = await this.getByPattern(pattern);
    const keys = Object.keys(matches);

    if (keys.length === 0) {
      return 0;
    }

    if (this.isReady) {
      // Delete from PostgreSQL and Redis
      try {
        await this.query(`
          DELETE FROM sulla_settings
          WHERE property LIKE $1
        `, [pattern.replace('*', '%')]);

        if (keys.length > 0) {
          await redisClient.hdel('sulla_settings', ...keys);
        }
      } catch (error) {
        console.error('Pattern deletion failed:', error);
      }
    } else {
      // File fallback
      try {
        const filePath = this.getFallbackFilePath();
        const content = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(content) as Record<string, any>;

        for (const key of keys) {
          delete data[key];
        }

        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      } catch (error) {
        console.warn('File pattern deletion failed:', error);
      }
    }

    return keys.length;
  }

  /**
   * Check if any settings exist matching pattern
   */
  public static async existsByPattern(pattern: string): Promise<boolean> {
    const matches = await this.getByPattern(pattern);
    return Object.keys(matches).length > 0;
  }
}
