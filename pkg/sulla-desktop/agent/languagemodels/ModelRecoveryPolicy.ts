// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ModelCandidate } from './modelRouter';

/** Defines the only routes recovery may attempt after a failed model call. */
export class ModelRecoveryPolicy {
  candidates(resolved: readonly ModelCandidate[], pinned: boolean, active: ModelCandidate): ModelCandidate[] {
    const candidates = resolved.length ? [...resolved] : [active];
    return pinned ? candidates.slice(0, 1) : candidates;
  }
}
