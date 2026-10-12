import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0115_create_skill_definitions';
import { migrationsRegistry } from '../index';

describe('0115 create skill definitions migration', () => {
  it('creates the skill table and the built-in seed ledger', () => {
    expect(up).toContain('CREATE TABLE IF NOT EXISTS skill_definitions');
    expect(up).toContain('slug                     TEXT NOT NULL UNIQUE');
    expect(up).toContain("CHECK (source_kind IN ('builtin', 'user', 'marketplace', 'resources'))");
    expect(up).toContain('CREATE TABLE IF NOT EXISTS skill_builtin_seed_ledger');
  });

  it('touches no existing table on the way up', () => {
    expect(up).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\b|INSERT INTO|ALTER TABLE/);
    expect(down).toContain('DROP TABLE IF EXISTS skill_definitions');
    expect(down).toContain('DROP TABLE IF EXISTS skill_builtin_seed_ledger');
  });

  it('is registered after the 0113 bookmark migration', () => {
    const names = migrationsRegistry.map(migration => migration.name);
    expect(names.indexOf('0115_create_skill_definitions')).toBeGreaterThan(names.indexOf('0113_bookmark_existing_artifacts'));
    expect(names.indexOf('0113_bookmark_existing_artifacts')).toBeGreaterThan(-1);
  });
});
