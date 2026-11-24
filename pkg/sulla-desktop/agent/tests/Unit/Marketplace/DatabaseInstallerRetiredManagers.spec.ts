// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PoolClient } from 'pg';
import type { MarketplaceTemplateDetail } from '@pkg/main/marketplace/client';

import { installPackageManifest, installStandaloneArtifact } from '../../../../main/marketplace/databaseInstaller';

class MarketplaceDatabaseStub {
  readonly queries: string[] = [];

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = {
      query: async (query: string) => {
        this.queries.push(query);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient;
    return callback(client);
  }
}

const retiredManagers = ['coding-manager-sol', 'coding-manager-grok', 'coding-manager-gpt'];
const publisher = { announce: vi.fn() };

function agentManifest(slug: string): Record<string, unknown> {
  return { metadata: { slug, title: `Agent ${ slug }` }, spec: { prompt: 'A test agent.' } };
}

function templateDetail(slug: string): MarketplaceTemplateDetail {
  return { id: `template-${ slug }`, kind: 'agent', slug, version: '1.0.0' } as unknown as MarketplaceTemplateDetail;
}

afterEach(() => vi.restoreAllMocks());

describe('marketplace retirement of long-tail Coding Managers', () => {
  it.each(retiredManagers)('skips standalone installs of %s before database writes', async(slug) => {
    // risk: agent custody — a marketplace package must not re-enable an archived manager.
    const database = new MarketplaceDatabaseStub();
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await installStandaloneArtifact(
      templateDetail(slug),
      { manifest: agentManifest(slug), files: {} },
      false,
      database,
      publisher,
    );

    expect(result).toEqual({ installed: false, reason: 'retired Coding Manager agents are not installable' });
    expect(database.queries).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Skipping marketplace agent "${ slug }"`));
  });

  it('skips retired package entries and continues installing allowed agents', async() => {
    // risk: agent custody — do not import retired agents or abort unrelated package contents.
    const database = new MarketplaceDatabaseStub();
    const result = await installPackageManifest('package-template', {
      apiVersion: 'sulla/v1',
      kind: 'package',
      slug: 'agent-bundle',
      name: 'Agent bundle',
      title: 'Agent bundle',
      version: '1.0.0',
      contents: [
        ...retiredManagers.map(slug => ({ kind: 'agent', slug, manifest: agentManifest(slug) })),
        { kind: 'agent', slug: 'allowed-agent', manifest: agentManifest('allowed-agent') },
      ],
    }, undefined, database, publisher);

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual([{ kind: 'agent', slug: 'allowed-agent' }]);
    expect(result.skipped).toEqual(retiredManagers.map(slug => ({
      kind: 'agent',
      slug,
      reason: 'retired Coding Manager agents are not installable',
    })));
    expect(database.queries.some(query => query.includes('INSERT INTO agent_definitions'))).toBe(true);
  });
});
