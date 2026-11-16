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
 *
 * Every Docker call is bounded (DOCKER_TIMEOUT_MS). A call that times out is
 * a failure: never fresh, and the stored secret counts as unreadable.
 */
export class GuestServiceSecretInstallState implements ServiceSecretInstallState {
  /** Compose project `sulla` + volume `sulla_postgres_data`. */
  static readonly POSTGRES_DATA_VOLUME = 'sulla_sulla_postgres_data';
  static readonly POSTGRES: ComposeServiceTarget = { service: 'postgres', container: 'sulla_postgres' };
  static readonly DOCKER_TIMEOUT_MS = 30_000;

  /** The quiet runner with every call bounded by the timeout. */
  private readonly docker: DockerCli;
  private readonly settings: GuestSettingsSecretRepository;

  constructor(
    /** Must not log command output. */
    quietDocker: DockerCli,
    private readonly waitHealthy: ServiceHealthWait,
    timeoutMs = GuestServiceSecretInstallState.DOCKER_TIMEOUT_MS,
    settings?: GuestSettingsSecretRepository,
  ) {
    this.docker = { run: args => GuestServiceSecretInstallState.bounded(quietDocker.run(args), timeoutMs, args[0]) };
    this.settings = settings ?? new GuestSettingsSecretRepository(this.docker);
  }

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

  private static bounded(call: Promise<string>, timeoutMs: number, command: string | undefined): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`docker ${ command ?? '' } did not answer within ${ Math.round(timeoutMs / 1000) }s`)), timeoutMs);
    });

    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  }

  async readDatabaseSecret(): Promise<string | null> {
    const postgres = GuestServiceSecretInstallState.POSTGRES;

    try {
      await this.docker.run(['start', postgres.container]);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];

      throw new Error(`PostgreSQL (${ postgres.container }) must be started to read the stored service secret; `
        + `start Sulla's services (or run "docker start ${ postgres.container }" in the Sulla VM) and start Sulla again (${ reason })`);
    }
    await this.waitHealthy(postgres);

    return this.settings.read();
  }
}
