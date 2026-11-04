// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type {
  AgentDefinition,
  AgentHeartbeatConfig,
  AgentModelSlot,
} from '@pkg/agent/database/models/AgentDefinitionModel';
import { DEFAULT_AGENT_RUN_LOCATION } from '@pkg/agent/database/models/AgentDefinitionModel';
import type { AgentDefinitionService } from '@pkg/agent/services/AgentDefinitionService';
import { AgentHeartbeatPolicy } from '@pkg/agent/services/AgentHeartbeatPolicy';
import type { AgentModelChoice } from '@pkg/agent/languagemodels/modelRoutingTypes';

export interface AgentDefinitionCreateRequest {
  slug: string;
  name: string;
  description?: string;
  provider?: string;
  modelSlot?: AgentModelSlot;
  prompt: string;
  runLocation?: 'vm' | 'container';
  heartbeat?: AgentHeartbeatConfig;
}

export interface AgentDefinitionUpdateRequest {
  name?: string;
  description?: string;
  provider?: string;
  modelSlot?: AgentModelSlot;
  modelChoice?: AgentModelChoice;
  prompt?: string;
  runLocation?: 'vm' | 'container';
  heartbeat?: AgentHeartbeatConfig;
}

/** Main-process application service behind the agent-definition IPC handlers. */
export class AgentDefinitionsIpcService {
  constructor(private readonly definitions: AgentDefinitionService) {}

  async create(input: AgentDefinitionCreateRequest): Promise<AgentDefinition> {
    const heartbeat = input.heartbeat
      ? AgentHeartbeatPolicy.assertConfig(input.heartbeat as unknown as Record<string, unknown>)
      : null;
    const created = await this.definitions.create({
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      provider: input.provider ?? null,
      modelSlot: input.modelSlot ?? 'secondary',
      systemPrompt: input.prompt,
      promptContent: input.prompt,
      promptFiles: { 'prompt.md': input.prompt },
      status: 'production',
      sourceKind: 'local',
      runLocation: input.runLocation ?? DEFAULT_AGENT_RUN_LOCATION,
    });
    return heartbeat ? (await this.definitions.patchConfig(created.id, { heartbeat }))! : created;
  }

  async update(id: string, patch: AgentDefinitionUpdateRequest): Promise<AgentDefinition | null> {
    const { heartbeat: rawHeartbeat, prompt, ...definitionPatch } = patch;
    const heartbeat = rawHeartbeat
      ? AgentHeartbeatPolicy.assertConfig(rawHeartbeat as unknown as Record<string, unknown>)
      : null;
    const updated = await this.definitions.update(id, {
      ...definitionPatch,
      ...(prompt !== undefined ? { systemPrompt: prompt, promptContent: prompt } : {}),
    });
    if (!updated || !heartbeat) return updated;
    return this.definitions.patchConfig(id, { heartbeat });
  }
}
