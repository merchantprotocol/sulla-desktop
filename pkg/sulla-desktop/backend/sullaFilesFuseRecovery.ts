// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'crypto';

export type FilesFuseContainerState = 'missing' | 'running' | 'exited' | 'dead' | 'restarting' | 'other';
export type FilesFuseRecoveryAction = 'none' | 'create' | 'recreate' | 'restart';

export interface FilesFuseRecoveryInput {
  containerState: FilesFuseContainerState;
  imageChanged: boolean;
  configChanged?: boolean;
  mountDead: boolean;
  nowMs: number;
  lastRestartMs?: number;
  restartCooldownMs: number;
}

const FILES_FUSE_CONFIG_FIELDS = ['image', 'volumes', 'environment', 'devices', 'cap_add', 'cap_drop', 'security_opt', 'entrypoint', 'command', 'healthcheck'] as const;

/** Stable digest of only the adapter settings whose change requires a recreate. */
export function hashFilesFuseServiceDefinition(service: Record<string, unknown>): string {
  const canonical = (value: unknown, sortArrays = false): unknown => {
    if (Array.isArray(value)) {
      const entries = value.map(entry => canonical(entry));

      return sortArrays ? entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) : entries;
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry, key === 'volumes' || key === 'devices' || key === 'cap_add' || key === 'cap_drop' || key === 'security_opt')]));
    }

    return value;
  };
  const definition = Object.fromEntries(FILES_FUSE_CONFIG_FIELDS.filter(field => field in service)
    .map(field => [field, canonical(service[field], field === 'volumes' || field === 'devices' || field === 'cap_add' || field === 'cap_drop' || field === 'security_opt')]));

  return crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

/** Docker inspect returns no output for a missing container when errors are suppressed. */
export function toFilesFuseContainerState(inspectOutput: string): FilesFuseContainerState {
  const state = inspectOutput.trim().split(/\s+/)[0]?.toLowerCase();

  if (!state || /no such (object|container)/i.test(inspectOutput)) return 'missing';

  return ['running', 'exited', 'dead', 'restarting'].includes(state) ? state as FilesFuseContainerState : 'other';
}

/** Decide the smallest safe recovery; only explicitly detected adapter config drift recreates it. */
export function decideFilesFuseRecovery(input: FilesFuseRecoveryInput): FilesFuseRecoveryAction {
  if (input.containerState === 'missing') return 'create';
  if (input.containerState === 'exited' || input.containerState === 'dead') return 'create';
  if (input.imageChanged || input.configChanged) return 'recreate';
  if (input.containerState !== 'running' || !input.mountDead) return 'none';
  if (input.lastRestartMs !== undefined && input.nowMs - input.lastRestartMs < input.restartCooldownMs) return 'none';

  return 'restart';
}
