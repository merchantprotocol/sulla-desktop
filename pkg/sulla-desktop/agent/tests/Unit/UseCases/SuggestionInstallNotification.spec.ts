// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const watcher = vi.hoisted(() => ({ notifyUseCaseChange: vi.fn(), broken: false }));

vi.mock('@pkg/main/sullaFilesWatcher', () => ({
  getSullaFilesWatcher: () => {
    if (watcher.broken) throw new Error('watcher not constructed');
    return { notifyUseCaseChange: watcher.notifyUseCaseChange };
  },
}));
vi.mock('@pkg/agent/database/PostgresClient', () => ({ postgresClient: {} }));
vi.mock('@pkg/agent/memory/MemoryPackLoader', () => ({ installMemoryPackForSkill: vi.fn(), uninstallPack: vi.fn() }));
vi.mock('@pkg/agent/extensions/ExtensionLoader', () => ({ reloadExtensionHooks: vi.fn() }));
vi.mock('@pkg/agent/integrations/packageLoader', () => ({
  IntegrationPackageLoader: class {}, integrationGrantStore: {}, resolveTrustedPublisherKeysPath: () => '', setIntegrationGrant: vi.fn(), trustedPublisherVerifier: vi.fn(),
}));

const { installStandaloneArtifact } = await import('@pkg/main/marketplace/databaseInstaller');

/** Commits whatever the installer writes; records statements so the test can prove the row was written. */
class CommittingDatabase {
  readonly statements: string[] = [];
  async transaction<T>(work: (client: any) => Promise<T>): Promise<T> {
    return work({ query: async(sql: string) => { this.statements.push(sql); return { rowCount: 0, rows: [] }; } });
  }
}

const functionDetail = { id: 'tpl-1', kind: 'function', slug: 'cash-forecast', version: '1.0.0', author_display: 'Example' } as any;
const functionArtifact = { manifest: { name: 'Cash forecast', spec: { runtime: 'python', entrypoint: 'main.py::handler' } }, files: {} };

describe('marketplace install → suggestion index notification', () => {
  beforeEach(() => { watcher.notifyUseCaseChange.mockReset(); watcher.broken = false; });

  it('reports a committed install as installed even when the suggestion notification fails', async() => {
    // risk: irreversible side effects — a post-commit notification error must not tell the user a committed install failed.
    watcher.broken = true;
    const db = new CommittingDatabase();
    const result = await installStandaloneArtifact(functionDetail, functionArtifact, false, db as any);
    expect(result).toEqual({ installed: true });
    expect(db.statements.some(sql => sql.includes('INSERT INTO function_definitions'))).toBe(true);
  });

  it('notifies the index with the installed use case after commit', async() => {
    // risk: data accuracy — a fresh install must reach suggestions without waiting for reconciliation.
    const db = new CommittingDatabase();
    await installStandaloneArtifact(functionDetail, functionArtifact, false, db as any);
    expect(watcher.notifyUseCaseChange).toHaveBeenCalledWith('function', 'cash-forecast', 'installed');
  });
});
