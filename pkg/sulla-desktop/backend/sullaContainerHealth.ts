// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Decides which unhealthy Sulla containers Desktop should recreate.
 *
 * Stateless services and FUSE adapters are recreated once they have been unhealthy for a
 * minute. Services that hold state or run long first-start migrations (Postgres, Files,
 * Vault, Accounts, Redis) get a much longer grace period so a slow migration is never
 * interrupted. Every container is capped so a service that cannot become healthy is not
 * restarted forever.
 */
export interface ManagedContainerRow {
  /** Docker container name, e.g. sulla_files_fuse. */
  container: string;
  /** Compose service name, e.g. sulla_files_fuse or workflow_manager. */
  service: string;
  /** Docker State.Status, e.g. running, exited, restarting. */
  state: string;
  /** Docker State.Health.Status, or 'none' when the image has no healthcheck. */
  health: string;
  /** Milliseconds since the container last (re)started. */
  runningForMs: number;
}

export const STATEFUL_SERVICES = new Set(['postgres', 'redis', 'sulla_files', 'sulla_vault', 'sulla_accounts']);
export const STATELESS_GRACE_MS = 60_000;
export const STATEFUL_GRACE_MS = 10 * 60_000;
export const MAX_AUTO_RECREATES = 3;

export interface HealthAction { container: string; service: string; reason: string }

/** The compose service that runs the Files FUSE adapter (it mounts /mnt/sulla-files). */
export const FILES_ADAPTER_SERVICE = 'sulla_files_fuse';

export function planUnhealthyRecreates(rows: ManagedContainerRow[], recreateCounts: ReadonlyMap<string, number>): HealthAction[] {
  const actions: HealthAction[] = [];

  for (const row of rows) {
    // The Files adapter whose bind source was already a dead FUSE mount never starts and
    // never gets a health status (Docker State.Status stays "created"), so it would
    // otherwise never be caught below. Heal it immediately; no grace period applies
    // since it never ran.
    const stuckCreated = row.state === 'created' && row.service === FILES_ADAPTER_SERVICE;

    // A container that was stopped on purpose (an idle on-demand service) keeps the last
    // health status Docker saw, which can be "unhealthy"; recreating it would start it again.
    const stoppedOnPurpose = row.state === 'exited' || row.state === 'dead';

    if (stoppedOnPurpose) continue;
    if (!stuckCreated && row.health !== 'unhealthy' && row.state !== 'restarting') continue;
    if ((recreateCounts.get(row.container) ?? 0) >= MAX_AUTO_RECREATES) continue;
    const grace = STATEFUL_SERVICES.has(row.service) ? STATEFUL_GRACE_MS : STATELESS_GRACE_MS;

    if (!stuckCreated && row.runningForMs < grace) continue;
    actions.push({
      container: row.container,
      service:   row.service,
      reason:    stuckCreated ? 'stuck created' : row.state === 'restarting' ? 'restart loop' : 'unhealthy',
    });
  }

  return actions;
}
