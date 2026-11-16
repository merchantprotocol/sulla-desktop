// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ServiceSecretInstallState } from '@pkg/agent/app/Services/ServiceSecret/ServiceSecretProvider';

import { GuestSettingsSecretRepository } from './Repositories/GuestSettingsSecretRepository';
import type { ComposeServiceTarget, DockerCli } from './sullaComposeContainers';

export type ServiceHealthWait = (target: ComposeServiceTarget) => Promise<void>;

/**
 * Answers the service secret provider's two install questions from the guest:
 *
 * - Fresh: neither the PostgreSQL data volume nor a PostgreSQL container
 *   exists yet, so nothing can have been derived from a service secret. Any
 *   doubt (Docker not answering) counts as installed: never a new secret.
 * - The stored secret: start the existing PostgreSQL container, wait until it
 *   is healthy, and read the setting in the guest (GuestSettingsSecretRepository).
 *   The Docker runner must not log stdout: it carries the secret.
 */
export class GuestServiceSecretInstallState implements ServiceSecretInstallState {
  /** Compose project `sulla` + volume `sulla_postgres_data`. */
  static readonly POSTGRES_DATA_VOLUME = 'sulla_sulla_postgres_data';
  static readonly POSTGRES: ComposeServiceTarget = { service: 'postgres', container: 'sulla_postgres' };

  constructor(
    /** Must not log command output. */
    private readonly quietDocker: DockerCli,
    private readonly waitHealthy: ServiceHealthWait,
    private readonly settings = new GuestSettingsSecretRepository(quietDocker),
  ) {}

  async isFresh(): Promise<boolean> {
    try {
      const volumes = GuestServiceSecretInstallState.lines(await this.quietDocker.run(['volume', 'ls', '--quiet']));
      const containers = GuestServiceSecretInstallState.lines(await this.quietDocker.run(['ps', '--all', '--format', '{{.Names}}']));

      return !volumes.includes(GuestServiceSecretInstallState.POSTGRES_DATA_VOLUME) && !containers.includes('sulla_postgres');
    } catch {
      return false;
    }
  }

  private static lines(output: string): string[] {
    return output.split('\n').map(line => line.trim()).filter(Boolean);
  }

  async readDatabaseSecret(): Promise<string | null> {
    const postgres = GuestServiceSecretInstallState.POSTGRES;

    await this.quietDocker.run(['start', postgres.container]);
    await this.waitHealthy(postgres);

    return this.settings.read();
  }
}
