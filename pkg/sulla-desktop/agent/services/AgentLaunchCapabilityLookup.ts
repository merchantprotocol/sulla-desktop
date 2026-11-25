// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentDefinitionService } from './AgentDefinitionService';

/** Resolves delegation capability from the live agent directory, independent of model routing. */
export class AgentLaunchCapabilityLookup {
  private cacheReady = false;
  private cachedAt = 0;
  private launchableSlugs = new Set<string>();

  public constructor(
    private readonly definitions: Pick<AgentDefinitionService, 'list'>,
    private readonly clock: () => number = Date.now,
    private readonly cacheWindowMs = 30_000,
  ) {}

  public async launchableAgentIds(agentIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (!this.cacheReady || this.clock() - this.cachedAt >= this.cacheWindowMs) {
      const definitions = await this.definitions.list();
      this.launchableSlugs = new Set(definitions
        .filter(definition => definition.can_call.length > 0)
        .map(definition => definition.slug));
      this.cachedAt = this.clock();
      this.cacheReady = true;
    }
    return new Set(agentIds.filter(agentId => this.launchableSlugs.has(agentId)));
  }
}
