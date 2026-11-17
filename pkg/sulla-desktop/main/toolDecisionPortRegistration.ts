// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { decisionService } from '@pkg/agent/services/DecisionService';
import { toolDecisionPort, type ToolDecisionPortRegistry } from '@pkg/agent/tools/toolDecisionPort';

/**
 * Desktop main hands the real approval inbox to tool calls. The Tools container never imports this module,
 * so its tool calls keep the fail-closed port from agent/tools/toolDecisionPort.ts.
 */
export function registerDesktopToolDecisionPort(registry: ToolDecisionPortRegistry = toolDecisionPort): void {
  registry.register(decisionService);
}

registerDesktopToolDecisionPort();
