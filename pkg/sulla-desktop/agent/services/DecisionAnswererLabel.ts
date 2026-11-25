// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionActor } from '@pkg/shared/decisions';

export class DecisionAnswererLabel {
  label(actor?: DecisionActor): string | undefined {
    if (!actor) return undefined;
    return actor.kind === 'human' ? 'your human' : actor.label?.trim() || actor.agentId?.trim() || 'agent';
  }
}
