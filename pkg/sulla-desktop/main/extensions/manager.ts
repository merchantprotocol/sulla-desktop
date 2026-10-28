// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChildProcessByStdio } from 'child_process';
import { Readable } from 'stream';

import { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import _ from 'lodash';

import { fetchMarketplaceData, invalidateMarketplaceCache } from './marketplaceData';
import { createRecipeExtension, RecipeExtensionImpl } from './recipeExtension';
import {
  Extension, ExtensionManager, SpawnOptions, SpawnResult,
} from './types';

import type { ContainerEngineClient } from '@pkg/backend/containerClient';
import { Settings } from '@pkg/config/settings';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import mainEvents from '@pkg/main/mainEvents';
import type { IpcMainEvents, IpcMainInvokeEvents, IpcRendererEvents } from '@pkg/typings/electron-ipc';
import Logging from '@pkg/utils/logging';
import { RecursiveReadonly } from '@pkg/utils/typeUtils';
import { openUrlInApp } from '@pkg/window';

const console = Logging.extensions;
const ipcMain = getIpcMainProxy(console);
let manager: ExtensionManager | undefined;

type IpcMainEventListener<K extends keyof IpcMainEvents> =
  (event: IpcMainEvent, ...args: Parameters<IpcMainEvents[K]>) => void;

type IpcMainEventHandler<K extends keyof IpcMainInvokeEvents> =
  (event: IpcMainInvokeEvent, ...args: Parameters<IpcMainInvokeEvents[K]>) =>
    Promise<ReturnType<IpcMainInvokeEvents[K]>> | ReturnType<IpcMainInvokeEvents[K]>;

type ReadableChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export class ExtensionManagerImpl implements ExtensionManager {
  /**
   * Recipe extensions keyed by slug, then version.
   */
  protected recipeExtensions: Record<string, Record<string, RecipeExtensionImpl>> = {};

  constructor(client: ContainerEngineClient) {
    this.client = client;
  }

  /** Container engine client, used to run Docker CLI commands for the app. */
  readonly client: ContainerEngineClient;

  /**
   * Mapping of event listeners we used with ipcMain.on(), which will be used to
   * ensure we unregister them correctly.
   */
  protected eventListeners: {
    [channel in keyof IpcMainEvents]?: IpcMainEventListener<channel>;
  } = {};

  /**
   * Mapping of event handlers we used with ipcMain.handle(), which will be used
   * to ensure we unregister them correctly.
   */
  protected eventHandlers: {
    [channel in keyof IpcMainInvokeEvents]?: IpcMainEventHandler<channel>;
  } = {};

  /**
   * Attach a listener to ipcMainEvents that will be torn down when this
   * extension manager shuts down.
   * @note Only one listener per topic is supported.
   */
  protected setMainListener<K extends keyof IpcMainEvents>(channel: K, listener: IpcMainEventListener<K>) {
    const oldListener = this.eventListeners[channel];

    if (oldListener) {
      console.error(`Removing duplicate event listener for ${ channel }`);
      ipcMain.removeListener(channel, oldListener);
    }
    this.eventListeners[channel] = listener as any;
    ipcMain.on(channel, listener);
  }

  /**
   * Attach a handler to ipcMainInvokeEvents that will be torn down when this
   * extension manager shuts down.
   * @note Only one handler per topic is supported.
   */
  protected setMainHandler<K extends keyof IpcMainInvokeEvents>(channel: K, handler: IpcMainEventHandler<K>) {
    const oldHandler = this.eventHandlers[channel];

    if (oldHandler) {
      console.error(`Removing duplicate event handler for ${ channel }`);
      ipcMain.removeHandler(channel);
    }
    this.eventHandlers[channel] = handler as any;
    ipcMain.handle(channel, handler);
  }

  /**
   * Docker CLI processes created in execStreaming() that may still be running.
   */
  protected processes: Record<string, WeakRef<ReadableChildProcess>> = {};

  async init(config: RecursiveReadonly<Settings>) {
    // Handle events from the renderer process.
    this.setMainListener('extensions/open-external', (...[, url]) => {
      openUrlInApp(url);
    });

    this.setMainListener('extensions/spawn/kill', (event, execId) => {
      const fullExecId = this.getFullExecId(event, execId);
      const process = this.processes[fullExecId]?.deref();

      process?.kill('SIGTERM');
      console.debug(`Killed ${ fullExecId }: ${ process }`);
    });

    this.setMainListener('extensions/spawn/streaming', (event, options) => {
      this.execStreaming(event, options, this.spawnDockerCli(event, options));
    });

    this.setMainHandler('extensions/spawn/blocking', (event, options) => {
      return this.execBlocking(this.spawnDockerCli(event, options));
    });

    // Install / uninstall extensions as needed.
    const tasks: Promise<any>[] = [];
    const { enabled: allowEnabled, list: allowListRaw } = config.application.extensions.allowed;
    const allowList = allowEnabled ? allowListRaw : undefined;

    for (const [repo, tag] of Object.entries(config.application.extensions.installed)) {
      if (!tag) {
        // If the tag is unset / falsy, we wanted to uninstall the extension.
        // There is no need to re-initialize it.
        continue;
      }

      tasks.push((async(repo: string, tag: string) => {
        const id = `${ repo }:${ tag }`;

        try {
          const extension = await this.getExtension(id);

          if (!extension) {
            throw new Error(`Extension ${ id } is not in the Sulla marketplace`);
          }

          return await extension.install(allowList);
        } catch (ex) {
          console.error(`Failed to install extension ${ id }`, ex);
          mainEvents.emit('settings-write', { application: { extensions: { installed: { [repo]: undefined } } } });
        }
      })(repo, tag));
    }
    await Promise.all(tasks);

    // Start all installed extensions (each runs its recipe start command).
    // Deferred to allow the container engine to finish initializing — extensions
    // that call Docker will fail if the socket isn't ready yet.
    setTimeout(() => {
      this.startInstalledExtensions().catch((err) => {
        console.error('[ExtensionManager] startInstalledExtensions failed:', err);
      });
    }, 10_000);

    // Register a listener to shut down extensions on quit
    mainEvents.handle('extensions/shutdown', this.triggerExtensionShutdown);
  }

  async getExtension(id: string, options: { preferInstalled?: boolean } = {}): Promise<Extension | undefined> {
    const [, slug, version] = /^(.*):(.*?)$/.exec(id) ?? ['', id, undefined];
    const preferInstalled = options?.preferInstalled ?? true;

    return await this.getRecipeExtension(slug ?? id, version, preferInstalled);
  }

  /**
   * Check the marketplace catalog for a recipe-based extension.
   * Returns a RecipeExtensionImpl if the catalog entry has an installable URL,
   * otherwise returns undefined.
   */
  protected async getRecipeExtension(
    slug: string,
    tag: string | undefined,
    preferInstalled: boolean,
  ): Promise<RecipeExtensionImpl | undefined> {
    // Check if we already have a cached recipe extension
    const recipeGroup = this.recipeExtensions[slug];

    if (recipeGroup) {
      if (tag && recipeGroup[tag]) {
        return recipeGroup[tag];
      }
      if (preferInstalled) {
        for (const ext of Object.values(recipeGroup)) {
          if (await ext.isInstalled()) {
            return ext;
          }
        }
      }
      if (tag) {
        // We know this slug is recipe-based; create a new version entry
        const ext = await createRecipeExtension(slug, tag);

        if (ext) {
          recipeGroup[tag] = ext;

          return ext;
        }
      }
    }

    // Check marketplace catalog
    let entries = await fetchMarketplaceData();
    let entry = entries.find(e => e.slug === slug);

    // If the slug is missing, refresh once in case we have stale cached marketplace data.
    if (!entry) {
      invalidateMarketplaceCache();
      entries = await fetchMarketplaceData();
      entry = entries.find(e => e.slug === slug);
    }

    if (!entry?.installable) {
      return undefined;
    }

    // This is a recipe-based extension
    const version = tag || entry.version;

    this.recipeExtensions[slug] ??= {};

    if (!this.recipeExtensions[slug][version]) {
      const ext = await createRecipeExtension(slug, version);

      if (ext) {
        this.recipeExtensions[slug][version] = ext;
      }
    }

    return this.recipeExtensions[slug][version];
  }

  async getInstalledExtensions() {
    // Get a list of all known extensions, installed or not.
    const allExts: Extension[] = Object.values(this.recipeExtensions).flatMap(group => Object.values(group));

    // Calculate if each is installed (in parallel).
    const states = await Promise.all(allExts.map(async ext => [ext, await ext.isInstalled()] as const));

    // Return the extensions that are marked as installed.
    return states.filter(([, state]) => state).map(([ext]) => ext);
  }

  /**
   * Build the process key for a Docker CLI exec, scoped to the sending frame.
   */
  protected getFullExecId(event: IpcMainEvent | IpcMainInvokeEvent, execId: string): string {
    return `${ event.senderFrame?.origin ?? '<closed>' }:${ execId }`;
  }

  /**
   * Run a Docker CLI command for the main application window.
   * Only frames served from the app:// protocol may use this.
   */
  protected spawnDockerCli(event: IpcMainEvent | IpcMainInvokeEvent, options: SpawnOptions): ReadableChildProcess {
    const { senderFrame } = event;

    if (!senderFrame) {
      throw new Error('Spawning docker client from closed sender frame');
    }
    if (new URL(senderFrame.origin).protocol !== 'app:') {
      throw new Error(`Refusing to run docker client for ${ senderFrame.origin }`);
    }
    if (options.scope !== 'docker-cli') {
      throw new Error(`Unexpected scope ${ options.scope }`);
    }

    return this.client.runClient(
      // For docker compatibility, strip quotes for any arguments.
      options.command.map(arg => (/^(["'])(.*)\1$/.exec(arg) ?? ['', '', arg])[2]),
      'stream',
      _.pick(options, ['cwd', 'env']));
  }

  /**
   * Execute a Docker CLI process, returning a promise that will be resolved
   * when the process completes.
   */
  protected execBlocking(process: ReadableChildProcess): Promise<SpawnResult> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let errored = false;

    process.stdout.on('data', (data: string | Buffer) => {
      stdout.push(typeof data === 'string' ? Buffer.from(data) : data);
    });
    process.stderr.on('data', (data: string | Buffer) => {
      stderr.push(typeof data === 'string' ? Buffer.from(data) : data);
    });

    return new Promise((resolve, reject) => {
      process.on('error', (error) => {
        errored = true;
        reject(error);
      });

      process.on('exit', (code, signal) => {
        if (errored) {
          return;
        }
        resolve({
          cmd:    process.spawnargs.join(' '),
          result: signal ?? code ?? 0,
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: Buffer.concat(stderr).toString('utf-8'),
        });
      });
    });
  }

  /**
   * Execute a Docker CLI process, with the output fed back to the calling
   * frame via IPC events.
   */
  protected execStreaming(event: IpcMainEvent, options: SpawnOptions, process: ReadableChildProcess) {
    const fullId = this.getFullExecId(event, options.execId);

    let errored = false;

    /***
     * Helper for event.senderFrame.send() to add checking of channel names and
     * process liveness.
     */
    const sendToFrame = <K extends keyof IpcRendererEvents>(channel: K, ...args: Parameters<IpcRendererEvents[K]>) => {
      if (this.processes[fullId]?.deref()) {
        event.senderFrame?.send?.(channel, ...args as any);
      } else {
        // If we get here, the process is only alive due to the closure, but the
        // weak ref has been removed; this happens if the client has killed the
        // process already.  In that case, just clean up and do not send anything
        // to the client frame.
        console.debug(`Sending ${ channel } to dead process ${ fullId }, force killing.`);
        process.kill('SIGKILL');
        // Close outputs to avoid buffered lines being sent after the process has been killed.
        process.stdout.destroy();
        process.stderr.destroy();
      }
    };

    process.stdout.on('data', (stdout: string | Buffer) => {
      sendToFrame('extensions/spawn/output', options.execId, { stdout: stdout.toString('utf-8') });
    });
    process.stderr.on('data', (stderr: string | Buffer) => {
      sendToFrame('extensions/spawn/output', options.execId, { stderr: stderr.toString('utf-8') });
    });
    process.on('error', (error) => {
      errored = true;
      sendToFrame('extensions/spawn/error', options.execId, error);
    });
    process.on('exit', (code, signal) => {
      if (errored) {
        return;
      }
      if (code !== null ) {
        sendToFrame('extensions/spawn/close', options.execId, code);
      } else if (signal !== null) {
        errored = true;
        sendToFrame('extensions/spawn/error', options.execId, signal);
      } else {
        errored = true;
        sendToFrame('extensions/spawn/error', options.execId, new Error('exited with neither code nor signal'));
      }
    });

    this.processes[fullId] = new WeakRef(process);
  }

  async shutdown() {
    // Remove our event listeners (to avoid issues when we switch backends).
    for (const untypedChannel in this.eventListeners) {
      const channel = untypedChannel as keyof IpcMainEvents;
      const listener = this.eventListeners[channel] as IpcMainEventListener<typeof channel>;

      ipcMain.removeListener(channel, listener);
    }

    for (const untypedChannel in this.eventHandlers) {
      ipcMain.removeHandler(untypedChannel as keyof IpcMainInvokeEvents);
    }

    await Promise.allSettled(Object.values(this.processes).map((proc) => {
      proc.deref()?.kill();
    }));

    mainEvents.handle('extensions/shutdown', undefined);
  }

  /**
   * Start all installed extensions whose persisted state is 'running'.
   * Recipe extensions run their `commands.start` from installation.yaml.
   */
  protected async startInstalledExtensions(): Promise<void> {
    const installed = await this.getInstalledExtensions();

    await Promise.allSettled(installed.map(async(ext) => {
      try {
        const state = await ext.getRunningState();

        if (state === 'running') {
          await ext.start();
        } else {
          console.debug(`Skipping auto-start for ${ ext.id } (persisted state: ${ state })`);
        }
      } catch (ex) {
        console.error(`Failed to start extension ${ ext.id } on boot:`, ex);
      }
    }));
  }

  async startExtension(id: string): Promise<void> {
    const ext = await this.getExtension(id);

    if (!ext || !(await ext.isInstalled())) {
      throw new Error(`Extension ${ id } is not installed`);
    }
    await ext.start();
  }

  async stopExtension(id: string): Promise<void> {
    const ext = await this.getExtension(id);

    if (!ext || !(await ext.isInstalled())) {
      throw new Error(`Extension ${ id } is not installed`);
    }
    await ext.stop();
  }

  async getExtensionStatus(id: string): Promise<'running' | 'stopped' | 'not_installed'> {
    const ext = await this.getExtension(id);

    if (!ext || !(await ext.isInstalled())) {
      return 'not_installed';
    }

    return await ext.getRunningState();
  }

  triggerExtensionShutdown = async() => {
    await Promise.all((await this.getInstalledExtensions()).map((extension) => {
      return extension.shutdown();
    }));
  };
}

function getExtensionManager(): Promise<ExtensionManager | undefined> {
  return Promise.resolve(manager);
}

export async function initializeExtensionManager(client: ContainerEngineClient, cfg: RecursiveReadonly<Settings>): Promise<void> {
  if (manager?.client === client) {
    // The manager is already the correct one; do nothing.
    return;
  }

  await manager?.shutdown();

  console.debug(`Creating new extension manager...`);
  manager = new ExtensionManagerImpl(client);

  await manager.init(cfg);
}

export default getExtensionManager;
