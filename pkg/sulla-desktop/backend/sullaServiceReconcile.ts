// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type RootCommandRunner = (...command: string[]) => Promise<unknown>;

export interface ReconcileServiceOptions {
  composeCommand: string[];
  service:        string;
  /** Published image Desktop refreshes before reconciling; undefined for builds/overrides. */
  refreshImage?:  string;
  run:            RootCommandRunner;
  /** Called between steps; throws when the reconciliation was superseded. */
  checkpoint?:    () => void;
  log?:           Pick<Console, 'warn'>;
}

/**
 * Brings one optional compose service to its desired state.
 *
 * A failed registry refresh is never fatal: compose then starts the service
 * from the image already present in the VM (`--pull never`). If `up` itself
 * fails (for example a container left over from an older definition that can
 * no longer start), the service is recreated once from the current definition.
 */
export async function reconcileComposeService(options: ReconcileServiceOptions): Promise<void> {
  const {
    composeCommand, service, refreshImage, run, checkpoint = () => undefined, log = console,
  } = options;

  checkpoint();
  if (refreshImage) {
    try {
      await run('docker', 'pull', refreshImage);
    } catch (error) {
      log.warn(`[Sulla] Could not refresh ${ refreshImage }; using the image already in the VM:`, error);
    }
  }
  checkpoint();
  const up = [...composeCommand, 'up', '-d', '--no-deps', ...(refreshImage ? ['--pull', 'never'] : [])];

  try {
    // Compose owns the desired-state diff. It leaves unchanged containers
    // running and recreates only services whose image or configuration changed.
    await run(...up, service);
  } catch (error) {
    checkpoint();
    log.warn(`[Sulla] Could not start ${ service } as-is; recreating it from the current definition:`, error);
    await run(...up, '--force-recreate', service);
  }
  checkpoint();
}
