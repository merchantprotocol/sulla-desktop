// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ModelCandidate } from './modelRouter';
import type { LLMFailureRecovery } from './providerRecovery';

/** Defines the only routes recovery may attempt after a failed model call. */
export class ModelRecoveryPolicy {
  candidates(resolved: readonly ModelCandidate[], active: ModelCandidate): ModelCandidate[] {
    const candidates = resolved.length ? [...resolved] : [active];
    return candidates;
  }

  /** Remaining same-provider calls after the initial failure (initial + 2 = 3 total). */
  additionalAttempts(failure: LLMFailureRecovery): number {
    return failure.retryPrimary ? 2 : 0;
  }

  canAdvance(failure: LLMFailureRecovery): boolean {
    return failure.fallbackAllowed;
  }
}
