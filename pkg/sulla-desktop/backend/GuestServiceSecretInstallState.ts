// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ServiceSecretInstallState } from '@pkg/agent/app/Services/ServiceSecret/ServiceSecretProvider';

import type { ComposeServiceTarget, DockerCli } from './sullaComposeContainers';

/** Opens the settings database (SullaSettingsModel.bootstrap). */
export interface SettingsDatabase {
  bootstrap(): Promise<void>;
}

export type ServiceHealthWait = (target: ComposeServiceTarget) => Promise<void>;

/**
 * Answers the service secret provider's two install questions from the guest:
 *
 * - Fresh: neither the PostgreSQL data volume nor a PostgreSQL container
 *   exists yet, so nothing can have been derived from a service secret. Any
 *   doubt (Docker not answering) counts as installed: never a new secret.
 * - Open the database: start the existing PostgreSQL and Redis containers
 *   (trust auth inside the guest, so no secret is needed), wait until they are
 *   healthy, then bootstrap settings so PostgreSQL can be read.
 */
export class GuestServiceSecretInstallState implements ServiceSecretInstallState {
  /** Compose project `sulla` + volume `sulla_postgres_data`. */
  static readonly POSTGRES_DATA_VOLUME = 'sulla_sulla_postgres_data';
  static readonly DATA_SERVICES: readonly ComposeServiceTarget[] = [
    { service: 'postgres', container: 'sulla_postgres' },
    { service: 'redis', container: 'sulla_redis' },
  ];

  constructor(
    private readonly docker: DockerCli,
    private readonly waitHealthy: ServiceHealthWait,
    private readonly settings: SettingsDatabase,
  ) {}

  async isFresh(): Promise<boolean> {
    try {
      const volumes = GuestServiceSecretInstallState.lines(await this.docker.run(['volume', 'ls', '--quiet']));
      const containers = GuestServiceSecretInstallState.lines(await this.docker.run(['ps', '--all', '--format', '{{.Names}}']));

      return !volumes.includes(GuestServiceSecretInstallState.POSTGRES_DATA_VOLUME) && !containers.includes('sulla_postgres');
    } catch {
      return false;
    }
  }

  private static lines(output: string): string[] {
    return output.split('\n').map(line => line.trim()).filter(Boolean);
  }

  async openDatabase(): Promise<void> {
    const targets = GuestServiceSecretInstallState.DATA_SERVICES;

    await this.docker.run(['start', ...targets.map(target => target.container)]);
    for (const target of targets) await this.waitHealthy(target);
    await this.settings.bootstrap();
  }
}
