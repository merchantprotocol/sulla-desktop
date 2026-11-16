// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';

import type { LinuxRuntimePaths } from './dockerHost';

export interface LinuxPublishedPort {
  /** Loopback host port. Services are never published on non-loopback interfaces. */
  hostPort: number;
  containerPort: number;
  protocol?: 'tcp' | 'udp';
}

export interface LinuxRuntimeComposeOptions {
  image: string;
  containerName: string;
  cpus: number;
  memoryMiB: number;
  ports: LinuxPublishedPort[];
}

export interface LinuxMountMapping {
  /** Absolute app-owned host directory, or undefined for a named volume. */
  source?: string;
  /** Named volume (retained by `compose down`). */
  volume?: string;
  target: string;
}

export const LINUX_RUNTIME_SERVICE = 'runtime';
export const LINUX_RUNTIME_COMPOSE_FILE = 'docker-compose.json';

/**
 * Builds the Compose definition of the single app-owned runtime container.
 *
 * Isolation properties (enforced by validate()): no privileged mode, no host
 * network/PID/IPC, no Docker socket or arbitrary host-path mount, all
 * capabilities dropped except those needed to write files, no-new-privileges,
 * and ports published on 127.0.0.1 only. Only paths under the app-owned
 * runtime root are ever bind-mounted.
 */
export class LinuxRuntimeComposeBuilder {
  /** Host-to-container path mapping for the persistent mounts. */
  mounts(paths: LinuxRuntimePaths): LinuxMountMapping[] {
    return [
      { source: paths.runtime, target: '/mnt/data' },
      { source: paths.files, target: '/mnt/sulla-files' },
      { source: paths.functionCatalog, target: '/mnt/sulla-functions/catalog' },
      { source: paths.functionInvocations, target: '/mnt/sulla-functions/invocations' },
      { source: paths.backups, target: '/mnt/backups' },
      { volume: 'worktrees', target: '/mnt/worktrees' },
    ];
  }

  build(paths: LinuxRuntimePaths, options: LinuxRuntimeComposeOptions): Record<string, unknown> {
    const mounts = this.mounts(paths);

    this.validate(paths, mounts, options);
    const volumes = mounts.map(mount => mount.volume ?
      { type: 'volume', source: mount.volume, target: mount.target } :
      { type: 'bind', source: mount.source, target: mount.target, bind: { create_host_path: false } });

    return {
      services: {
        [LINUX_RUNTIME_SERVICE]: {
          image:          options.image,
          container_name: options.containerName,
          command:        ['sleep', 'infinity'],
          init:           true,
          restart:        'no',
          privileged:     false,
          cap_drop:       ['ALL'],
          cap_add:        ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
          security_opt:   ['no-new-privileges:true'],
          cpus:           options.cpus,
          mem_limit:      `${ options.memoryMiB }m`,
          ports:          options.ports.map(port => `127.0.0.1:${ port.hostPort }:${ port.containerPort }/${ port.protocol ?? 'tcp' }`),
          volumes,
          healthcheck:    { test: ['CMD', 'test', '-d', '/mnt/data'], interval: '5s', timeout: '3s', retries: 12 },
        },
      },
      volumes: Object.fromEntries(mounts.filter(mount => mount.volume).map(mount => [mount.volume, {}])),
    };
  }

  /** Writes the compose file into the private compose directory and returns its absolute path. */
  async write(paths: LinuxRuntimePaths, options: LinuxRuntimeComposeOptions): Promise<string> {
    const document = this.build(paths, options);
    const file = path.join(paths.compose, LINUX_RUNTIME_COMPOSE_FILE);

    // JSON is valid YAML, so Compose reads it without a YAML writer dependency.
    await fs.promises.writeFile(file, JSON.stringify(document, undefined, 2), { mode: 0o600 });

    return file;
  }

  private validate(paths: LinuxRuntimePaths, mounts: LinuxMountMapping[], options: LinuxRuntimeComposeOptions): void {
    if (!/^[a-z0-9][a-z0-9_.\/:@-]*$/i.test(options.image)) throw new Error('Runtime image reference is invalid.');
    if (!/^sulla-desktop-[a-z0-9_-]+$/.test(options.containerName)) throw new Error('Runtime container name must use the sulla-desktop- prefix.');
    if (!Number.isFinite(options.cpus) || options.cpus <= 0 || !Number.isFinite(options.memoryMiB) || options.memoryMiB < 256) {
      throw new Error('Runtime CPU and memory limits are invalid.');
    }
    for (const mount of mounts) {
      if (!path.posix.isAbsolute(mount.target)) throw new Error('Mount targets must be absolute container paths.');
      if (mount.source === undefined) continue;
      const relative = path.relative(paths.root, mount.source);

      if (!path.isAbsolute(mount.source) || relative.startsWith('..') || path.isAbsolute(relative) || /docker\.sock/.test(mount.source)) {
        throw new Error('Only directories inside the app-owned runtime root may be mounted.');
      }
    }
    const seen = new Set<string>();

    for (const port of options.ports) {
      const key = `${ port.protocol ?? 'tcp' }:${ port.hostPort }`;

      if (!Number.isInteger(port.hostPort) || !Number.isInteger(port.containerPort) || port.hostPort < 1024 || port.hostPort > 65535 ||
        port.containerPort < 1 || port.containerPort > 65535) {
        throw new Error('Published ports must be integers; host ports must be unprivileged (1024-65535).');
      }
      if (seen.has(key)) throw new Error('Published host ports must be unique.');
      seen.add(key);
    }
  }
}
