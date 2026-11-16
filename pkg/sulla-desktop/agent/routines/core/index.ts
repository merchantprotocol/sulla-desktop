// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Core routines — locked, baked-in routines distributed with Sulla Desktop.
 *
 * Every definition listed here is re-asserted into the `workflows` table on
 * boot by seedCoreRoutines(), marked system = true. They are visible and
 * runnable and may be disabled by the human, but cannot be edited or deleted
 * through any user-facing surface (enforced in WorkflowModel + the workflow
 * tools). Deleting a row from the DB self-heals on the next launch.
 *
 * To add a new core routine: author its WorkflowDefinition as a TS module in
 * this directory and add it to CORE_ROUTINES below. To stop shipping one, move
 * its id to RETIRED_CORE_ROUTINE_IDS: the seeder then archives and disables the
 * already-seeded row on boot instead of deleting it.
 */

import { DEFAULT_CORE_ROUTINE_AGENT_ID } from './defaultCoreAgent';
import { DREAMER_DEFINITION } from './dreamer';

export const CORE_ROUTINES: readonly Record<string, any>[] = [
  DREAMER_DEFINITION,
];

/**
 * Core routines that no longer ship. Their rows are kept (history, executions)
 * but archived + disabled on every boot so no scheduler arms them again.
 */
export const RETIRED_CORE_ROUTINES: readonly { id: string; reason: string }[] = [
  // Per-domain nightly identity dreamer over the legacy identity_observations
  // table; replaced by the single hourly batching Dreamer over v7 memory.
  { id: 'core-routine-dream-about-human', reason: 'replaced by the single batching Dreamer (core-routine-dreamer)' },
];

for (const retired of RETIRED_CORE_ROUTINES) {
  if (CORE_ROUTINES.some(routine => routine.id === retired.id)) {
    throw new Error(`Core routine ${ retired.id } cannot be both shipped and retired`);
  }
}

for (const routine of CORE_ROUTINES) {
  const customAgentNode = routine.nodes?.find((node: any) =>
    node.data?.subtype === 'agent' && node.data?.config?.agentId !== DEFAULT_CORE_ROUTINE_AGENT_ID,
  );
  if (customAgentNode) {
    throw new Error(
      `Locked core routine ${ routine.id } node ${ customAgentNode.id } must use ${ DEFAULT_CORE_ROUTINE_AGENT_ID }`,
    );
  }
}
