// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';

import _ from 'lodash';

import {
  ContainerComposeExecOptions, ReadableProcess, ContainerComposeOptions,
  ContainerEngineClient, ContainerRunOptions, ContainerStopOptions,
  ContainerRunClientOptions, ContainerComposePortOptions, ContainerBasicOptions,
} from './types';

import { VMExecutor } from '@pkg/backend/backend';
import dockerRegistry from '@pkg/backend/containerClient/registry';
import { ErrorCommand, spawn, spawnFile } from '@pkg/utils/childProcess';
import { parseImageReference } from '@pkg/utils/dockerUtils';
import Logging, { Log } from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { executable } from '@pkg/utils/resources';
import { defined } from '@pkg/utils/typeUtils';

const console = Logging.moby;

type runClientOptions = ContainerRunClientOptions & {
  /** The executable to run, defaulting to this.executable (i.e. "docker") */
  executable?: string;
};

export class MobyClient implements ContainerEngineClient {
  constructor(vm: VMExecutor, endpoint: string) {
    this.vm = vm;
    this.endpoint = endpoint;
  }

  readonly vm:       VMExecutor;
  readonly executable = executable('docker');
  readonly endpoint: string;

  /**
   * Run a list of cleanup functions in reverse.
   */
  protected async runCleanups(cleanups: (() => Promise<unknown>)[]) {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (e) {
        console.error('Failed to run cleanup:', e);
      }
    }
  }

  protected async makeContainer(imageID: string): Promise<string> {
    const { stdout, stderr } = await this.runClient(['create', '--entrypoint=/', imageID], 'pipe');
    const container = stdout.trim();

    console.debug(stderr.trim());
    if (!container) {
      throw new Error(`Failed to create container ${ imageID }`);
    }

    return container;
  }

  async waitForReady(): Promise<void> {
    let successCount = 0;
    let failureCount = 0;
    let lastOutput = { stdout: '', stderr: '' };
    const startTime = Date.now();

    // Two consecutive successes (not three) filter out a daemon that answers
    // once while still restarting. Service health is a separate readiness
    // stream and must not debounce Docker itself.
    for (;;) {
      try {
        await this.runClient(['system', 'info'], 'pipe');
        if (++successCount < 2) {
          await util.promisify(setTimeout)(250);
          continue;
        }
        console.log(`[startup-phase] ${ new Date().toISOString() } phase=docker-api-probe elapsedMs=${ Date.now() - startTime } failures=${ failureCount }`);

        return;
      } catch (ex) {
        successCount = 0;
        failureCount++;
        if (failureCount > 10 && ex && typeof ex === 'object') {
          const output = { stdout: '', stderr: '' };

          if ('stdout' in ex && typeof ex.stdout === 'string') output.stdout = ex.stdout;
          if ('stderr' in ex && typeof ex.stderr === 'string') output.stderr = ex.stderr;
          if (output.stdout !== lastOutput.stdout || output.stderr !== lastOutput.stderr) {
            console.error(`Failed to run docker system info after ${ failureCount } failures (will retry):`, output);
            lastOutput = output;
          }
        }
        await util.promisify(setTimeout)(250);
      }
    }
  }

  readFile(imageID: string, filePath: string): Promise<string>;
  readFile(imageID: string, filePath: string, options: { encoding?: BufferEncoding; }): Promise<string>;
  async readFile(imageID: string, filePath: string, options?: { encoding?: BufferEncoding }): Promise<string> {
    const encoding = options?.encoding ?? 'utf-8';

    console.debug(`Reading file ${ imageID }:${ filePath }`);

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rd-moby-readfile-'));
    const tempFile = path.join(workDir, path.basename(filePath));

    // `docker cp ... -` returns a tar file, which isn't what we want.  It's
    // easiest to just copy the file to disk and read it.
    try {
      await this.copyFile(imageID, filePath, workDir, { silent: true });

      return await fs.promises.readFile(tempFile, { encoding });
    } finally {
      await fs.promises.rm(workDir, { recursive: true, maxRetries: 3 });
    }
  }

  copyFile(imageID: string, sourcePath: string, destinationPath: string): Promise<void>;
  copyFile(imageID: string, sourcePath: string, destinationPath: string, options: { silent?: true }): Promise<void>;
  async copyFile(imageID: string, sourcePath: string, destinationPath: string, options?: { silent?: boolean }): Promise<void> {
    const cleanups: (() => Promise<unknown>)[] = [];

    if (!options?.silent) {
      console.debug(`Copying ${ imageID }:${ sourcePath } to ${ destinationPath }`);
    }

    const container = await this.makeContainer(imageID);

    cleanups.push(() => this.runClient(['rm', container], console));

    try {
      if (sourcePath.endsWith('/')) {
        // If we're copying a directory, add "." so we don't create an extra
        // directory.
        sourcePath += '.';
      }
      await this.runClient(
        ['cp', '--follow-link', `${ container }:${ sourcePath }`, destinationPath],
        console);
    } finally {
      await this.runCleanups(cleanups);
    }
  }

  async getTags(imageName: string, options?: ContainerBasicOptions) {
    let results = new Set<string>();

    try {
      results = new Set(await dockerRegistry.getTags(imageName));
    } catch (ex) {
      // We may fail here if the image doesn't exist / has an invalid host.
      console.debugE(`Could not get tags from registry for ${ imageName }, ignoring:`, ex);
    }

    try {
      const desired = parseImageReference(imageName);
      const { stdout } = await this.runClient(
        ['image', 'list', '--format={{ .Repository }}:{{ .Tag }}'], 'pipe', options);

      for (const imageRef of stdout.split(/\s+/).filter(v => v)) {
        const info = parseImageReference(imageRef);

        if (info?.tag && info.equalName(desired)) {
          results.add(info.tag);
        }
      }
    } catch (ex) {
      // Failure to list images is acceptable.
      console.debugE(`Could not get tags of existing images for ${ imageName }, ignoring:`, ex);
    }

    return results;
  }

  async run(imageID: string, options?: ContainerRunOptions): Promise<string> {
    const args = ['container', 'run', '--detach'];

    args.push('--restart', options?.restart === 'always' ? 'always' : 'no');
    if (options?.name) {
      args.push('--name', options.name);
    }
    args.push(imageID);

    try {
      const { stdout, stderr } = await this.runClient(args, 'pipe');

      console.debug(stderr.trim());

      return stdout.trim();
    } catch (ex: any) {
      if (Object.prototype.hasOwnProperty.call(ex, ErrorCommand)) {
        const match = /container name "[^"]*" is already in use by container "(?<id>[0-9a-f]+)"./.exec(ex.stderr ?? '');
        const result = match?.groups?.['id'];

        if (result) {
          return result;
        }
      }
      throw ex;
    }
  }

  async stop(container: string, options?: ContainerStopOptions): Promise<void> {
    if (options?.delete && options.force) {
      const { stderr } = await this.runClient(['container', 'rm', '--force', container], 'pipe');

      if (!/Error: No such container: \S+/.test(stderr)) {
        console.debug(stderr.trim());
      }

      return;
    }

    await this.runClient(['container', 'stop', container]);
    if (options?.delete) {
      await this.runClient(['container', 'rm', container]);
    }
  }

  async composeUp(options: ContainerComposeOptions): Promise<void> {
    const args = ['--project-directory', options.composeDir];

    if (options.name) {
      args.push('--project-name', options.name);
    }
    args.push('up', '--quiet-pull', '--wait', '--remove-orphans');

    await this.runClient(args, console, { ...options, executable: 'docker-compose' });
    console.debug('ran docker compose up');
  }

  async composeDown(options: ContainerComposeOptions): Promise<void> {
    const args = [
      options.name ? ['--project-name', options.name] : [],
      ['--project-directory', options.composeDir, 'down'],
    ].flat();

    await this.runClient(args, console, { ...options, executable: 'docker-compose' });
    console.debug('ran docker compose down');
  }

  composeExec(options: ContainerComposeExecOptions): Promise<ReadableProcess> {
    const args = [
      options.name ? ['--project-name', options.name] : [],
      ['--project-directory', options.composeDir, 'exec'],
      options.user ? ['--user', options.user] : [],
      options.workdir ? ['--workdir', options.workdir] : [],
      [options.service, ...options.command],
    ].flat();

    return Promise.resolve(this.runClient(args, 'stream',
      { ...options, executable: 'docker-compose' }));
  }

  async composePort(options: ContainerComposePortOptions): Promise<string> {
    const args = [
      options.name ? ['--project-name', options.name] : [],
      ['--project-directory', options.composeDir, 'port'],
      options.protocol ? ['--protocol', options.protocol] : [],
      [options.service, options.port.toString()],
    ].flat();
    const { stdout } = await this.runClient(args, 'pipe', { ...options, executable: 'docker-compose' });

    return stdout.trim();
  }

  runClient(args: string[], stdio?: 'ignore', options?: runClientOptions): Promise<Record<string, never>>;
  runClient(args: string[], stdio: Log, options?: runClientOptions): Promise<Record<string, never>>;
  runClient(args: string[], stdio: 'pipe', options?: runClientOptions): Promise<{ stdout: string; stderr: string; }>;
  runClient(args: string[], stdio: 'stream', options?: runClientOptions): ReadableProcess;
  runClient(args: string[], stdio?: 'ignore' | 'pipe' | 'stream' | Log, options?: runClientOptions) {
    // Always add the `bin` directory, as docker CLI plugins may need them too.
    const dirsToAdd = [path.join(paths.resources, process.platform, 'bin')];
    const executableName = options?.executable ?? this.executable;
    const isCLIPlugin = /^docker-(?!credential-)/.test(executableName);

    const binType = isCLIPlugin ? 'docker-cli-plugins' : 'bin';
    const executableDir = path.join(paths.resources, process.platform, binType);
    const executable = path.resolve(executableDir, executableName);

    if (isCLIPlugin) {
      dirsToAdd.push(executableDir);
    }

    const opts = _.merge({ env: _.merge({}, process.env) }, options ?? {}, {
      env: {
        DOCKER_HOST: this.endpoint,
        PATH:        `${ process.env.PATH }${ path.delimiter }${ dirsToAdd.join(path.delimiter) }`,
      },
    });

    // Due to TypeScript reasons, we have to make each branch separately.
    switch (stdio) {
    case 'ignore':
    case undefined:
      return spawnFile(executable, args, { ...opts, stdio: 'ignore' });
    case 'stream':
      return spawn(executable, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    case 'pipe':
      return spawnFile(executable, args, { ...opts, stdio: 'pipe' });
    }

    return spawnFile(executable, args, { ...opts, stdio });
  }
}
