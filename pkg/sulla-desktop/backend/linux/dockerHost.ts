// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile as nodeExecFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DockerComposeRuntime, DockerComposeProjectSpec, assertDockerComposeProject, DockerComposeCommandResult, DockerComposeCommandRunner,
} from '@pkg/backend/containerClient/dockerComposeRuntime';

export type DockerHostCommandResult = DockerComposeCommandResult;
export type DockerHostCommandRunner = DockerComposeCommandRunner;
export type LinuxComposeProject = DockerComposeProjectSpec;

export interface LinuxDockerHostInspection {
  cliAvailable: boolean;
  composeVersion?: string;
  engineAvailable: boolean;
  endpoint?: string;
  socketPath?: string;
  rootless: boolean;
  errors: string[];
}

export interface LinuxRuntimePaths {
  root: string;
  runtime: string;
  compose: string;
  secrets: string;
  functionCatalog: string;
  functionInvocations: string;
  files: string;
  backups: string;
}

const MIN_COMPOSE = [2, 17, 0];

/** Create private, app-owned host paths for compose bind sources. */
export async function prepareLinuxRuntimePaths(appDataDirectory: string): Promise<LinuxRuntimePaths> {
  if (!path.isAbsolute(appDataDirectory) || path.resolve(appDataDirectory) === path.parse(appDataDirectory).root) {
    throw new Error('Linux runtime data directory must be an absolute non-root application-data path.');
  }
  const root = path.join(path.resolve(appDataDirectory), 'runtime');
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Linux runtime data directory must be a real directory.');
  await fs.promises.chmod(root, 0o700);

  const paths = {
    root,
    runtime: path.join(root, 'state'),
    compose: path.join(root, 'compose'),
    secrets: path.join(root, 'secrets'),
    functionCatalog: path.join(root, 'functions', 'catalog'),
    functionInvocations: path.join(root, 'functions', 'invocations'),
    files: path.join(root, 'files'),
    backups: path.join(root, 'backups'),
  };
  for (const directory of Object.values(paths).slice(1)) {
    let current = root;
    for (const component of path.relative(root, directory).split(path.sep)) {
      current = path.join(current, component);
      await fs.promises.mkdir(current, { recursive: true, mode: 0o700 });
      const stat = await fs.promises.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linux runtime paths must remain inside real app-owned directories.');
      await fs.promises.chmod(current, 0o700);
    }
  }

  return Object.freeze(paths);
}

/**
 * Linux runtime bridge for a user-installed rootless Docker Engine.
 *
 * It intentionally does not start/stop the host daemon or accept Docker socket
 * URLs from callers. The app owns only its Compose project; `down` never removes
 * volumes. Rootful or remote Docker endpoints are rejected because a mounted
 * daemon socket would grant service containers host-root access or cross-host
 * filesystem semantics.
 */
export class LinuxDockerHost extends DockerComposeRuntime {
  private readonly run: DockerHostCommandRunner;
  private readonly socketPath: string;

  constructor(run: DockerHostCommandRunner = runDocker, socketPath = process.env.DOCKER_HOST ?? '') {
    super(run);
    this.run = run;
    this.socketPath = socketPath;
  }

  async inspect(): Promise<LinuxDockerHostInspection> {
    const errors: string[] = [];
    let composeVersion: string | undefined;
    let endpoint: string | undefined;
    let socketPath: string | undefined;
    let engineAvailable = false;
    let rootless = false;
    let cliAvailable = true;

    try {
      const result = await this.run(['compose', 'version', '--short']);
      composeVersion = result.stdout.trim().replace(/^v/i, '');
      if (result.exitCode !== 0 || !supportsCompose(composeVersion)) {
        errors.push('Docker Compose v2.17.0 or newer is required.');
      }
    } catch {
      cliAvailable = false;
      errors.push('The Docker CLI and Compose v2 plugin are required.');
    }

    try {
      const context = await this.run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
      endpoint = context.stdout.trim();
      if (context.exitCode !== 0 || !endpoint.startsWith('unix://')) {
        errors.push('A local Unix-socket Docker Engine is required; remote Docker contexts are not supported.');
      } else {
        try { socketPath = dockerSocketPathFromEndpoint(endpoint) } catch {
          errors.push('Docker Engine endpoint must use an absolute local Unix socket path.');
        }
        if (this.socketPath && !this.socketPath.startsWith('unix://')) {
          errors.push('DOCKER_HOST must not point to a remote Docker Engine.');
        }
        const info = await this.run(['info', '--format', '{{json .SecurityOptions}}']);
        engineAvailable = info.exitCode === 0;
        if (engineAvailable) {
          try {
            const securityOptions = JSON.parse(info.stdout) as unknown;
            rootless = Array.isArray(securityOptions) && securityOptions.some(option => typeof option === 'string' && /(?:^|[, ])name=rootless(?:[, ]|$)/i.test(option));
          } catch {
            rootless = false;
          }
        }
        if (!engineAvailable) errors.push('The Docker Engine is not reachable.');
        else if (!rootless) errors.push('A rootless Docker Engine is required to protect the Linux host.');
      }
    } catch {
      errors.push('The Docker Engine context could not be inspected.');
    }

    return { cliAvailable, composeVersion, engineAvailable, endpoint, socketPath, rootless, errors };
  }

  async assertReady(): Promise<LinuxDockerHostInspection> {
    const inspection = await this.inspect();
    if (inspection.errors.length) throw new Error(`Linux runtime prerequisites are not met: ${ inspection.errors.join(' ') }`);

    return inspection;
  }

  /** The runtime image must already exist locally: Sulla never substitutes a generic image. */
  async assertImagePresent(image: string, buildHint: string): Promise<void> {
    const result = await this.run(['image', 'inspect', '--format', '{{.Id}}', image]);

    if (result.exitCode !== 0) throw new Error(`The Sulla runtime image "${ image }" is not present. ${ buildHint }`);
  }

  /** Start only this app-owned Compose project and wait for running/healthy services. */
  override async startProject(project: LinuxComposeProject): Promise<void> {
    validateProject(project);
    await this.assertReady();
    await super.startProject(project);
  }

  /** Stop this project only. Named/anonymous volumes and the shared daemon are retained. */
  override async stopProject(project: LinuxComposeProject): Promise<void> {
    validateProject(project);
    await this.assertReady();
    await super.stopProject(project);
  }
}

function validateProject(project: LinuxComposeProject): void {
  assertDockerComposeProject(project);
  // The shared lifecycle checks the app namespace and endpoint overrides;
  // Linux additionally requires the compose file to exist as a regular file.
  if (!path.isAbsolute(project.composeFile)) throw new Error('Docker Compose file path must be absolute.');
  const file = fs.lstatSync(project.composeFile);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Docker Compose file must be a regular file.');
}

function supportsCompose(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);

  for (let index = 0; index < MIN_COMPOSE.length; index++) {
    if (actual[index] > MIN_COMPOSE[index]) return true;
    if (actual[index] < MIN_COMPOSE[index]) return false;
  }

  return true;
}

/** Return the path to a validated local Unix Docker socket for Compose bind sources. */
export function dockerSocketPathFromEndpoint(endpoint: string): string {
  if (!endpoint.startsWith('unix://')) throw new Error('Docker Engine endpoint must be a local Unix socket.');
  const socketPath = decodeURIComponent(new URL(endpoint).pathname);
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) throw new Error('Docker Engine socket path is invalid.');

  return socketPath;
}

/** Host `docker` runner. Long operations (image pulls, compose up) pass a larger timeout. */
export function dockerRunner(timeoutMs = 30_000): DockerHostCommandRunner {
  return (args, env) => runDocker(args, env, timeoutMs);
}

async function runDocker(args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<DockerHostCommandResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      const failure = error as NodeJS.ErrnoException & { code?: number };
      if (typeof failure.code === 'number') {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: failure.code });
        return;
      }
      reject(new Error('The Docker CLI could not be started.'));
    });
  });
}
