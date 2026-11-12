// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'path';

export interface DockerComposeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Platform adapter for `docker` in a host shell or an app-owned Linux guest. */
export type DockerComposeCommandRunner = (args: string[], environment?: NodeJS.ProcessEnv) => Promise<DockerComposeCommandResult>;

export interface DockerComposeProjectSpec {
  /** Absolute Compose-file path as seen by the Docker CLI process. */
  composeFile: string;
  /** Namespace reserved for this app's Compose resources. */
  projectName: string;
  environment?: NodeJS.ProcessEnv;
  readyTimeoutSeconds?: number;
}

/** Shared Compose lifecycle used by Linux's rootless Engine and Windows's app-owned WSL distro. */
export class DockerComposeRuntime {
  private readonly runDocker: DockerComposeCommandRunner;

  constructor(runDocker: DockerComposeCommandRunner) {
    this.runDocker = runDocker;
  }

  async startProject(project: DockerComposeProjectSpec): Promise<void> {
    validateProject(project);
    const timeout = Math.max(30, Math.min(900, Math.round(project.readyTimeoutSeconds ?? 300)));
    const result = await this.runDocker([
      'compose', '--project-name', project.projectName, '--project-directory', path.posix.dirname(project.composeFile),
      '--file', project.composeFile, 'up', '--detach', '--wait', '--wait-timeout', String(timeout),
    ], project.environment);

    if (result.exitCode !== 0) throw new Error(`Docker Compose could not start project "${ project.projectName }" (exit ${ result.exitCode }).`);
  }

  /** Stops only the named app project. The daemon and its volumes are preserved. */
  async stopProject(project: DockerComposeProjectSpec): Promise<void> {
    validateProject(project);
    const result = await this.runDocker([
      'compose', '--project-name', project.projectName, '--project-directory', path.posix.dirname(project.composeFile),
      '--file', project.composeFile, 'down', '--remove-orphans',
    ], project.environment);

    if (result.exitCode !== 0) throw new Error(`Docker Compose could not stop project "${ project.projectName }" (exit ${ result.exitCode }).`);
  }
}

const PROJECT_NAME = /^sulla-desktop-[a-z0-9_-]{1,52}$/;

function validateProject(project: DockerComposeProjectSpec): void {
  if (!PROJECT_NAME.test(project.projectName)) throw new Error('Docker Compose project name must use the sulla-desktop- prefix.');
  if (!path.posix.isAbsolute(project.composeFile)) throw new Error('Docker Compose file path must be absolute.');
  if (project.environment && ('DOCKER_HOST' in project.environment || 'DOCKER_CONTEXT' in project.environment)) {
    throw new Error('Compose environment must not override the validated local Docker endpoint.');
  }
}
