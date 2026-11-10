// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { BrowseToolsWorker } from '../../../../tools/meta/browse_tools';
import { IntegrationCredentialStatus, type IntegrationIdSource } from '../../../../tools/meta/IntegrationCredentialStatus';
import { ToolCatalogIndex } from '../../../../tools/meta/ToolCatalogIndex';
import { ToolSearchRanker } from '../../../../tools/meta/ToolSearchRanker';
import { allToolManifests } from '../../../../tools/allManifests';
import { ToolRegistry } from '../../../../tools/registry';

function registryWithAllTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerManifests(allToolManifests);
  return registry;
}

function idSource(ids: Set<string> | 'never'): IntegrationIdSource & { loadEnabledIntegrationIds: ReturnType<typeof vi.fn> } {
  return {
    loadEnabledIntegrationIds: vi.fn(() => (ids === 'never' ? new Promise<Set<string>>(() => {}) : Promise.resolve(ids))),
  };
}

function buildWorker(source: IntegrationIdSource, timeoutMs = 50): BrowseToolsWorker {
  return new BrowseToolsWorker({
    catalog:     new ToolCatalogIndex(registryWithAllTools()),
    credentials: new IntegrationCredentialStatus(source, 60_000, timeoutMs),
    ranker:      new ToolSearchRanker(),
  });
}

/** Runs the real browse logic (not the tool-call wrapper) and returns the text. */
async function browse(worker: BrowseToolsWorker, input: Record<string, string>): Promise<string> {
  const response = await (worker as any)._validatedCall(input);
  return response.responseString as string;
}

/** The first `sulla <category>/<tool>` command line in a query result. */
function firstCommand(result: string): string {
  return result.split('\n').find(line => line.startsWith('  sulla ')) ?? '';
}

describe('browse_tools exact discovery', () => {
  it.each(['ready_pr', 'ready pr', 'github/ready_pr', 'github_ready_pr'])('puts github ready_pr first for %s', async(query) => {
    // risk: operability — agents must find the un-draft command instead of closing and reopening PRs.
    const result = await browse(buildWorker(idSource(new Set())), { query });
    expect(firstCommand(result)).toContain('sulla github/ready_pr ');
  });

  it('puts agents stop_agent_job first for a natural-language query', async() => {
    // risk: reliability — an agent must find the existing stop command rather than inventing a recovery path.
    const result = await browse(buildWorker(idSource(new Set())), { query: 'stop agent job' });
    expect(firstCommand(result)).toContain('sulla agents/stop_agent_job ');
  });
});

describe('browse_tools never blocks on credentials', () => {
  it('query mode does not look up credentials at all', async() => {
    // risk: reliability — keyword search must not depend on the database being up.
    const source = idSource(new Set(['github']));
    const result = await browse(buildWorker(source), { query: 'ready pr' });
    expect(result).toContain('sulla github/ready_pr');
    expect(source.loadEnabledIntegrationIds).not.toHaveBeenCalled();
  });

  it('category mode returns within the timeout when the credential lookup never resolves', async() => {
    // risk: reliability — a hung DB must not hang browse_tools.
    const started = Date.now();
    const result = await browse(buildWorker(idSource('never'), 50), { category: 'github' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toContain('sulla github/ready_pr');
    expect(result).not.toContain('credentials connected');
  });

  it('default mode returns within the timeout when the credential lookup never resolves', async() => {
    // risk: reliability — the category list must still render with the DB silent.
    const started = Date.now();
    const result = await browse(buildWorker(idSource('never'), 50), {});
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toContain('## Available Tool Categories');
  });

  it('shows the connected badge when the integration has credentials', async() => {
    // risk: operability — agents should see which integrations are usable without a failed call.
    const result = await browse(buildWorker(idSource(new Set(['github'])), 1_000), { category: 'github' });
    expect(result).toContain('## github ✓ credentials connected');
  });
});
