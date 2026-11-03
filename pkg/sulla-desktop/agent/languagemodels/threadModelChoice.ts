// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentModelChoice } from './modelRoutingTypes';

/** A per-thread default overrides an agent's model setting without mutating that agent. */
export function threadModelChoice(metadata: unknown, fallback: AgentModelChoice = { mode: 'list' }): AgentModelChoice {
 const value = (metadata as { modelChoice?: AgentModelChoice } | null)?.modelChoice;
 if (!value || !['list', 'class', 'pin'].includes(value.mode)) return fallback;
 return value;
}
