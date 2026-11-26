// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { CliFaultError } from './cliFaultRecovery';

/** Replaying a stalled turn is safe only when no tool could have side effects still in flight. */
export class CliStallRecoveryPolicy {
  createFault(message: string, toolsInFlight: number, unresolvedTool: boolean): CliFaultError {
    const retrySafe = toolsInFlight === 0 && !unresolvedTool;
    const safety = retrySafe ? '' : `${ message.trimEnd().endsWith('.') ? '' : '.' } Recovery was not attempted because a tool was still unresolved.`;
    return new CliFaultError('stall', `${ message }${ safety }`, undefined, retrySafe, !retrySafe);
  }
}
