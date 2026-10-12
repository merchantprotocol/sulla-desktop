import { describe, expect, it } from '@jest/globals';

import { down, up } from '../0112_add_project_assigned_agent';
import { migrationsRegistry } from '../index';

describe('0112 add project assigned agent migration', () => {
  it('adds a nullable assigned_agent column to work_projects', () => {
    expect(up).toContain('ALTER TABLE work_projects');
    expect(up).toContain('ADD COLUMN IF NOT EXISTS assigned_agent TEXT;');
    expect(up).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it('is additive: no drops, updates or deletes on the way up', () => {
    expect(up).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\b|INSERT INTO/);
    expect(down).toContain('DROP COLUMN IF EXISTS assigned_agent');
  });

  it('is registered right after 0111', () => {
    const names = migrationsRegistry.map(migration => migration.name);
    expect(names.indexOf('0112_add_project_assigned_agent')).toBe(names.indexOf('0111_add_agent_routing') + 1);
  });
});
