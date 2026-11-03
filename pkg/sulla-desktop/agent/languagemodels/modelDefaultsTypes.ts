// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentModelChoice } from './modelRoutingTypes';

export type ModelDefaultChoice =
 | { kind: 'agent'; agentId: string }
 | { kind: 'model'; choice: AgentModelChoice };

export interface ModelDefaults {
 chat: ModelDefaultChoice;
 heartbeat: ModelDefaultChoice;
}

export const MODEL_DEFAULTS_IPC = {
 get: 'model-defaults:get',
 set: 'model-defaults:set',
 reset: 'model-defaults:reset',
} as const;
