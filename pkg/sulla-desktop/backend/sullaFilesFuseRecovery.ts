// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type FilesFuseContainerState = 'missing' | 'running' | 'exited' | 'dead' | 'restarting' | 'other';
export type FilesFuseRecoveryAction = 'none' | 'create' | 'recreate' | 'restart';

export interface FilesFuseRecoveryInput {
  containerState: FilesFuseContainerState;
  imageChanged: boolean;
  mountDead: boolean;
  nowMs: number;
  lastRestartMs?: number;
  restartCooldownMs: number;
}

/** Decide the smallest safe recovery; config drift is intentionally not an input. */
export function decideFilesFuseRecovery(input: FilesFuseRecoveryInput): FilesFuseRecoveryAction {
  if (input.containerState === 'missing') return 'create';
  if (input.containerState === 'exited' || input.containerState === 'dead') return 'create';
  if (input.imageChanged) return 'recreate';
  if (input.containerState !== 'running' || !input.mountDead) return 'none';
  if (input.lastRestartMs !== undefined && input.nowMs - input.lastRestartMs < input.restartCooldownMs) return 'none';

  return 'restart';
}
