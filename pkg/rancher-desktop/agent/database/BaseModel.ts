// src/database/BaseModel.ts

import { postgresClient } from './PostgresClient';
import type { QueryResultRow } from 'pg';

type WhereClause = Record<string, any>;

interface ModelAttributes {
  [key: string]: any;
}

export abstract class BaseModel<T extends ModelAttributes = ModelAttributes> {
  protected abstract readonly tableName: string;
  protected readonly primaryKey: string = 'id';
  protected readonly timestamps: boolean = true;
  protected readonly fillable: string[] = [];
  protected readonly guarded: string[] = ['*'];

  /**
   * Cast property definitions for automatic type conversion
   * Supported types: json, array, timestamp, string, integer, float, boolean
   */
  protected readonly casts: Record<string, string> = {};

  public attributes: Partial<T> = {};
  protected original: Partial<T> = {};
  protected exists: boolean = false;

  constructor() { }

  public fill(attributes: Partial<T>) {
    const fillable = this.fillable || [];
    const guarded = this.guarded || ['*'];

    if (guarded.includes('*') && fillable.length === 0) {
      throw new Error('Model has no fillable fields defined');
    }

    for (const [key, value] of Object.entries(attributes)) {
      if ((fillable.includes(key) || !guarded.includes('*')) && value !== null && value !== undefined) {
        this.attributes[key as keyof T] = this.castFromDatabase(key, value);
      }
    }

    return this;
  }

  protected databaseFill(attributes: Partial<T>) {
    for (const [key, value] of Object.entries(attributes)) {
      this.attributes[key as keyof T] = this.castFromDatabase(key, value);
    }
    return this;
  }

  /**
   * Cast a value for storage in the database (pack)
   */
  private castForDatabase(key: string, value: any): any {
    if (value === null || value === undefined) return value;

    const castType = this.casts[key];
    if (!castType) return value;

    switch (castType) {
      case 'json':
      case 'array':
      case 'object':
        return JSON.stringify(value);

      case 'timestamp':
      case 'datetime':
        if (value instanceof Date) {
          return value.toISOString();
        }
        return value;

      case 'integer':
      case 'int':
        return parseInt(value, 10);

      case 'float':
      case 'decimal':
      case 'double':
        return parseFloat(value);

      case 'boolean':
      case 'bool':
        return Boolean(value);

      case 'string':
      default:
        return String(value);
    }
  }

  /**
   * Cast a value from database storage (unpack)
   */
  private castFromDatabase(key: string, value: any): any {
    if (value === null || value === undefined) return value;

    const castType = this.casts[key];
    if (!castType) return value;

    switch (castType) {
      case 'json':
      case 'object':
        if (typeof value === 'string') {
          try {
            return JSON.parse(value);
          } catch (err) {
            console.warn(`Failed to parse JSON for field ${key}:`, value);
            return value;
          }
        }
        return value;

      case 'array':
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : value;
          } catch (err) {
            console.warn(`Failed to parse array for field ${key}:`, value);
            return value;
          }
        }
        return value;

      case 'timestamp':
      case 'datetime':
        if (typeof value === 'string') {
          const date = new Date(value);
          return isNaN(date.getTime()) ? value : date;
        }
        return value;

      case 'integer':
      case 'int':
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? value : parsed;
        }
        return value;

      case 'float':
      case 'decimal':
      case 'double':
        if (typeof value === 'string') {
          const parsed = parseFloat(value);
          return isNaN(parsed) ? value : parsed;
        }
        return value;

      case 'boolean':
      case 'bool':
        if (typeof value === 'string') {
          return value.toLowerCase() === 'true' || value === '1';
        }
        return Boolean(value);

      case 'string':
      default:
        return String(value);
    }
  }

  public updateAttributes(attributes: Partial<T>): void {
    this.fill(attributes);
  }

  protected get tableRef(): string {
    return `"${this.tableName}"`; // public schema - no prefix
  }

  static async find<T extends BaseModel>(this: new (...args: any[]) => T, id: string | number): Promise<T | null> {
    const model = new this();
    const result = await postgresClient.queryOne(
      `SELECT * FROM ${model.tableRef} WHERE "${model.primaryKey}" = $1 LIMIT 1`,
      [id]
    );

    if (!result) return null;

    const instance = new this(result);
    instance.exists = true;
    instance.original = { ...result };
    instance.databaseFill(result);
    return instance;
  }

  static async all<T extends BaseModel>(this: new (...args: any[]) => T): Promise<T[]> {
    const model = new (this as any)();
    const rows = await postgresClient.queryAll(
      `SELECT * FROM ${model.tableRef} ORDER BY "${model.primaryKey}" ASC`
    );

    return rows.map(row => {
      const instance = new (this as any)(row);
      instance.exists = true;
      instance.original = { ...row };
      instance.databaseFill(row);
      return instance;
    });
  }

  static async where<T extends BaseModel>(
    this: new (...args: any[]) => T,
    conditions: WhereClause | string,
    value?: any
  ): Promise<T[]> {
    const model = new (this as any)();
    let query = `SELECT * FROM ${model.tableRef}`;
    const params: any[] = [];

    if (typeof conditions === 'string') {
      if (conditions.includes('=') || conditions.includes('>') || conditions.includes('<') || conditions.includes('LIKE') || conditions.includes('ILIKE')) {
        // Raw SQL condition
        query += ` WHERE ${conditions}`;
        if (Array.isArray(value)) {
          params.push(...value);
        } else {
          params.push(value);
        }
      } else {
        // Simple column name
        query += ` WHERE "${conditions}" = $1`;
        params.push(value);
      }
    } else {
      const clauses = Object.entries(conditions).map(([k], i) => {
        params.push(conditions[k]);
        return `"${k}" = $${i + 1}`;
      });
      if (clauses.length > 0) {
        query += ` WHERE ${clauses.join(' AND ')}`;
      }
    }

    const rows = await postgresClient.queryAll(query, params);

    return rows.map(row => {
      const instance = new (this as any)(row);
      instance.exists = true;
      instance.original = { ...row };
      instance.databaseFill(row);
      return instance;
    });
  }

  static async create<T extends BaseModel>(
    this: new () => T,
    attributes: Partial<ModelAttributes>
  ): Promise<T> {
    const model = new this();
    model.fill(attributes);
    return model.save();
  }

  async save(): Promise<this> {
    const fillable = this.fillable || [];
    const guarded = this.guarded || ['*'];

    // Never include primary key in INSERT if it's null/undefined/empty
    if (!this.exists && (this.attributes[this.primaryKey] == null || this.attributes[this.primaryKey] === '')) {
      delete this.attributes[this.primaryKey];
    }

    if (this.exists) {
      const changes = Object.entries(this.attributes)
        .filter(([k, v]) => this.original[k] !== v)
        .filter(([k]) => fillable.includes(k) || !guarded.includes('*'))
        // Fix #49, #50: Exclude timestamp columns from changes to prevent duplicate assignment
        .filter(([k]) => k !== 'updated_at' && k !== 'created_at');

      if (changes.length === 0) return this;

      const sets = changes.map(([k], i) => `"${k}" = $${i + 1}`).join(', ');
      const values = changes.map(([k, v]) => this.castForDatabase(k, v));
      values.push(this.attributes[this.primaryKey]);

      let updateQuery = `UPDATE ${this.tableRef} SET ${sets}`;
      if (this.timestamps) {
        updateQuery += `, "updated_at" = CURRENT_TIMESTAMP`;
      }
      updateQuery += ` WHERE "${this.primaryKey}" = $${values.length}`;

      await postgresClient.query(updateQuery, values);
    } else {
      // Explicitly exclude primary key from INSERT keys/values
      const entries = Object.entries(this.attributes)
        .filter(([k, v]) =>
          (fillable.includes(k) || !guarded.includes('*')) &&
          v !== null && v !== undefined
        );
      console.log('INSERT entries', entries);
      const keys = entries.map(([k]) => k);
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const values = entries.map(([k, v]) => this.castForDatabase(k, v));

      let insertQuery: string;
      if (this.timestamps) {
        insertQuery = `INSERT INTO ${this.tableRef} (${keys.map(k => `"${k}"`).join(', ')}${keys.length ? ', ' : ''}"created_at", "updated_at") 
                      VALUES (${placeholders}${placeholders ? ', ' : ''}CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                      RETURNING *`;
      } else {
        insertQuery = `INSERT INTO ${this.tableRef} (${keys.map(k => `"${k}"`).join(', ')}) 
                      VALUES (${placeholders})
                      RETURNING *`;
      }

      const result = await postgresClient.query(insertQuery, values);

      if (result?.[0]) {
        const castedAttributes: Partial<T> = {};
        for (const [key, value] of Object.entries(result[0])) {
          castedAttributes[key as keyof T] = this.castFromDatabase(key, value);
        }
        this.attributes = castedAttributes;
        this.exists = true;
        this.original = { ...this.attributes };
      }
    }

    return this;
  }

  async delete(): Promise<boolean> {
    if (!this.exists) return false;

    const result = await postgresClient.query(
      `DELETE FROM ${this.tableRef} WHERE "${this.primaryKey}" = $1`,
      [this.attributes[this.primaryKey]]
    );

    this.exists = false;
    return (result.length ?? 0) > 0;
  }

  get id(): any {
    return this.attributes[this.primaryKey];
  }

  get attributesSnapshot(): Readonly<Partial<T>> {
    return { ...this.attributes };
  }

  static async query(sql: string, params: any[] = []): Promise<QueryResultRow[]> {
    return await postgresClient.queryAll(sql, params);
  }
}