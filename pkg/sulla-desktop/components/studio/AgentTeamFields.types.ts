// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentModelTiers } from '@pkg/agent/languagemodels/agentModelTiers';
import type { AgentModelChoice } from '@pkg/agent/languagemodels/modelRoutingTypes';

export interface AgentTeamMember {
  id:           string;
  slug:         string;
  name:         string;
  description?: string;
  enabled:      boolean;
  status:       string;
  canCall:      string[];
  modelChoice?: AgentModelChoice;
  type?:        string | null;
}

export interface AgentTeamModelDraft {
  choice:     AgentModelChoice;
  savedTiers: AgentModelTiers | null;
  tiers:      AgentModelTiers | null;
}
