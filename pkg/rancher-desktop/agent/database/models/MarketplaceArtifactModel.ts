import fs from 'node:fs';
import path from 'node:path';

import { postgresClient } from '../PostgresClient';

export type StoredFile = string | { encoding: 'base64'; content: string };

export interface FunctionDefinition {
  slug:                    string;
  name:                    string;
  description:             string;
  manifest:                Record<string, any>;
  runtime:                 'python' | 'node' | 'shell' | 'agent';
  files:                   Record<string, StoredFile>;
  version:                 string | null;
  source_kind:             'user' | 'marketplace';
  user_edited:             boolean;
  marketplace_template_id: string | null;
  marketplace_author:      string | null;
  created_at:              Date | string;
  updated_at:              Date | string;
}

export interface IntegrationDefinition {
  slug:                    string;
  name:                    string;
  description:             string;
  manifest:                Record<string, any>;
  files:                   Record<string, StoredFile>;
  version:                 string | null;
  source_kind:             'user' | 'marketplace';
  user_edited:             boolean;
  marketplace_template_id: string | null;
  marketplace_author:      string | null;
  created_at:              Date | string;
  updated_at:              Date | string;
}

export interface RecipeDefinition extends IntegrationDefinition {
  compose: string;
}

export class FunctionDefinitionModel {
  static findBySlug(slug: string): Promise<FunctionDefinition | null> {
    return postgresClient.queryOne('SELECT * FROM function_definitions WHERE slug = $1', [slug]);
  }

  static list(): Promise<FunctionDefinition[]> {
    return postgresClient.query('SELECT * FROM function_definitions ORDER BY slug', []);
  }
}

export class IntegrationDefinitionModel {
  static findBySlug(slug: string): Promise<IntegrationDefinition | null> {
    return postgresClient.queryOne('SELECT * FROM integration_definitions WHERE slug = $1', [slug]);
  }

  static list(): Promise<IntegrationDefinition[]> {
    return postgresClient.query('SELECT * FROM integration_definitions ORDER BY slug', []);
  }
}

export class RecipeDefinitionModel {
  static findBySlug(slug: string): Promise<RecipeDefinition | null> {
    return postgresClient.queryOne('SELECT * FROM recipe_definitions WHERE slug = $1', [slug]);
  }

  static list(): Promise<RecipeDefinition[]> {
    return postgresClient.query('SELECT * FROM recipe_definitions ORDER BY slug', []);
  }
}

/** Materialize a DB artifact into a caller-owned temporary directory. */
export function materializeStoredFiles(root: string, files: Record<string, StoredFile>): void {
  for (const [relative, stored] of Object.entries(files)) {
    if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..') || relative.includes('\\')) {
      throw new Error(`Refusing unsafe stored file path: ${ relative }`);
    }
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = typeof stored === 'string' ? Buffer.from(stored, 'utf8') : Buffer.from(stored.content, 'base64');
    fs.writeFileSync(target, content);
  }
}
