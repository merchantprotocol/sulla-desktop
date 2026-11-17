// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { DEFAULT_AGENT_RUN_LOCATION } from '../database/models/AgentDefinitionModel';
import { effectiveAgentRunLocation } from '@pkg/backend/sullaRuntime/state';
import { SULLA_DESKTOP_CHANNEL_ID } from './ChatAgentRouting';
import type { AgentGraphState } from '../nodes/Graph';

export class AgentRunLocationResolver {
  private static readonly vmOperatorChannels: ReadonlySet<string> = new Set([SULLA_DESKTOP_CHANNEL_ID, 'heartbeat', 'mobile-relay']);

  constructor(private readonly normalize: (location: 'vm' | 'container') => 'vm' | 'container' = effectiveAgentRunLocation) {}

  resolve(state: AgentGraphState, channelId: string): 'vm' | 'container' {
    const requested = AgentRunLocationResolver.vmOperatorChannels.has(channelId)
      ? 'vm'
      : state.metadata.agent?.runLocation ?? DEFAULT_AGENT_RUN_LOCATION;
    return this.normalize(requested);
  }
}
