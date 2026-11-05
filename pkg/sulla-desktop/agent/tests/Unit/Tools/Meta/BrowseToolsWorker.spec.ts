// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { BrowseToolsWorker } from '../../../../tools/meta/browse_tools';
import { allToolManifests } from '../../../../tools/allManifests';
import { ToolRegistry } from '../../../../tools/registry';

class BrowseToolsRegisteredHarness {
  readonly registry = new ToolRegistry();

  constructor() {
    this.registry.registerManifests(allToolManifests);
  }

  async search(query: string): Promise<string> {
    const worker = await this.registry.createTool('browse_tools');
    return (await worker.call({ query })).result as string;
  }
}

describe('browse_tools exact discovery', () => {
  it.each(['ready_pr', 'ready pr', 'github/ready_pr'])('puts the ready PR tool first for %s', async(query) => {
    // risk: operability — agents must discover the safe draft-to-ready command instead of guessing a tool name.
    const result = await new BrowseToolsRegisteredHarness().search(query);
    expect(result.indexOf('sulla github/ready_pr')).toBeGreaterThanOrEqual(0);
    expect(result.indexOf('sulla github/ready_pr')).toBeLessThan(result.indexOf('sulla github/merge_pr'));
  });

  it('puts stop_agent_job first for a natural-language query', async() => {
    // risk: reliability — an agent must find the existing stop command rather than inventing a recovery path.
    const result = await new BrowseToolsRegisteredHarness().search('stop agent job');
    expect(result.indexOf('sulla agents/stop_agent_job')).toBeGreaterThanOrEqual(0);
  });
});
