// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Resets only per-turn execution state while preserving a delegated thread's messages and identity. */
export class DelegatedTurnPreparer {
  prepare(state: any): void {
    const metadata = state?.metadata;
    if (!metadata) throw new Error('Cannot prepare a delegated turn without graph metadata.');
    metadata.consecutiveSameNode = 0;
    metadata.iterations = 0;
    metadata.agentLoopCount = 0;
    metadata.cycleComplete = false;
    metadata.waitingForUser = false;
  }
}
