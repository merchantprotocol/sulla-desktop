import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('Projects schema ownership', () => {
  it('keeps runtime Projects models verification-only', () => {
    for (const path of [
      'pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts',
      'pkg/rancher-desktop/agent/database/models/WorkLaneDefinitionModel.ts',
    ]) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(source).not.toMatch(/CREATE\s+(TABLE|INDEX|EXTENSION)|ALTER\s+TABLE/i);
      expect(source).toContain('PostgresProjectsSchemaVerifier');
    }
  });
});
