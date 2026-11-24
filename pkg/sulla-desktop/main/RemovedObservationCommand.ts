// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const REMOVED_OBSERVATION_MEMORY_MESSAGE = 'Observation memory has been removed from Sulla.';

/** Returns the retirement error for legacy observation CLI paths. */
export class RemovedObservationCommand {
  private readonly retiredCommands = new Set([
    'add_observational_memory',
    'search_observations',
    'list_observations',
    'remove_observational_memory',
    'add_identity_observation',
    'search_identity_observations',
    'list_identity_observations',
    'remove_identity_observation',
    'update_identity_section',
  ]);

  errorFor(category: string, command: string): string | null {
    if (category !== 'observation' && category !== 'meta') return null;
    return this.retiredCommands.has(command) ? REMOVED_OBSERVATION_MEMORY_MESSAGE : null;
  }
}
