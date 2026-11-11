// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it, vi } from 'vitest';

import { UseCaseChangeAnnouncer, type UseCaseChangeTransport } from '../../../useCases/UseCaseChangeBus';
import type { UseCaseChangeEvent } from '../../../useCases/UseCaseSuggestionIndex';

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

/** Records what the installer announces; `fail` makes the broadcast transport reject like a down Redis. */
class RecordingTransport implements UseCaseChangeTransport {
  readonly published: UseCaseChangeEvent[] = [];
  fail = false;
  async publish(_channel: string, message: string): Promise<void> {
    if (this.fail) throw new Error('redis down');
    const { type, slug, change } = JSON.parse(message);
    this.published.push({ type, slug, change });
  }
  async subscribe(): Promise<() => Promise<void>> { return async() => undefined; }
}
const quiet = { info: () => {} };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('marketplace install → suggestion index notification', () => {
  it('reports a committed install as installed even when the suggestion broadcast fails', async() => {
    // risk: irreversible side effects — a post-commit notification error must not tell the user a committed install failed.
    const transport = Object.assign(new RecordingTransport(), { fail: true });
    const db = new CommittingDatabase();
    const result = await installStandaloneArtifact(functionDetail, functionArtifact, false, db as any, new UseCaseChangeAnnouncer(transport, quiet));
    await flush();
    expect(result).toEqual({ installed: true });
    expect(db.statements.some(sql => sql.includes('INSERT INTO function_definitions'))).toBe(true);
  });

  it('reports a committed install even when the transport throws synchronously', async() => {
    // risk: irreversible side effects — a broken transport must not surface as a failed install.
    const db = new CommittingDatabase();
    const throwingTransport = { publish: () => { throw new Error('sync boom'); }, subscribe: async() => async() => undefined } as unknown as UseCaseChangeTransport;
    await expect(installStandaloneArtifact(functionDetail, functionArtifact, false, db as any, new UseCaseChangeAnnouncer(throwingTransport, quiet))).resolves.toEqual({ installed: true });
  });

  it('reports a committed install even when the injected publisher itself throws', async() => {
    // risk: irreversible side effects — a throwing publisher must not surface as a failed install.
    const db = new CommittingDatabase();
    const publisher = { announce: () => { throw new Error('publisher boom'); } };
    await expect(installStandaloneArtifact(functionDetail, functionArtifact, false, db as any, publisher as any)).resolves.toEqual({ installed: true });
    expect(db.statements.some(sql => sql.includes('INSERT INTO function_definitions'))).toBe(true);
  });

  it('announces the installed use case on the injected publisher after commit', async() => {
    // risk: data accuracy — a fresh install must reach suggestions without waiting for reconciliation.
    const transport = new RecordingTransport();
    const db = new CommittingDatabase();
    await installStandaloneArtifact(functionDetail, functionArtifact, false, db as any, new UseCaseChangeAnnouncer(transport, quiet));
    await flush();
    expect(transport.published).toEqual([{ type: 'function', slug: 'cash-forecast', change: 'installed' }]);
  });
});
