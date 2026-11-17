// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { decisionService } from '../../../pkg/sulla-desktop/agent/services/DecisionService.js';
import { toolDecisionPort, type ToolDecisionPortRegistry } from '../../../pkg/sulla-desktop/agent/tools/toolDecisionPort.js';

/**
 * The Tools container hands tool calls the same approval inbox main uses: DecisionService runs in the container
 * with Postgres, the pending-decision store and the approval policies, exactly as it does when base.ts lazy-loads
 * it. Without this registration every approval-gated tool would hit UnavailableToolDecisionPort and be refused.
 *
 * Only DecisionService's static imports are loaded at startup. Its Desktop-only edges stay lazy (see
 * toolsLoadedModules.spec.ts), so this module never pulls Desktop main into the container.
 */
export function registerContainerToolDecisionPort(registry: ToolDecisionPortRegistry = toolDecisionPort): void {
  registry.register(decisionService);
}

registerContainerToolDecisionPort();
