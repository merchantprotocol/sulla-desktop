// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const registryPath = 'repositories/VaultRepositories.ts';
const protectedRepositories = [
  'PostgresLocalAuthorityRepository', 'PostgresRewrapHistoryRepository', 'PostgresSullaCloudRevocationRepository',
  'PostgresVaultAuditLogRepository', 'PostgresVaultItemRepository', 'PostgresVaultUserRepository',
  'PostgresVaultRecoveryRepository', 'PostgresIntegrationStateRepository', 'PostgresVaultMigrationRepository',
  'PostgresVaultSyncStateRepository', 'PostgresLegacyCredentialRepository', 'PostgresDesktopAccountRepository',
  'PostgresFilesCloudEscrowRepository', 'PostgresFilesKeyBundleRepository',
];

class ProtectedRepositoryConstructionScanner {
  async findViolations(): Promise<string[]> {
    const files = await this.sourceFiles(sourceRoot);
    const violations: string[] = [];
    for (const file of files) {
      const path = relative(sourceRoot, file).replaceAll('\\', '/');
      if (path === registryPath) continue;
      const source = await readFile(file, 'utf8');
      for (const className of protectedRepositories) {
        if (new RegExp(`\\bnew\\s+${className}\\s*(?:<[^>]+>)?\\s*\\(`).test(source)) {
          violations.push(`${path}: constructs ${className}`);
        }
      }
    }
    return violations;
  }

  private async sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? this.sourceFiles(path) : entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }));
    return nested.flat();
  }
}

describe('VaultRepositories composition boundary', () => {
  it('keeps every protected repository construction inside the registry', async() => {
    expect(await new ProtectedRepositoryConstructionScanner().findViolations()).toEqual([]);
  });
});
