// sulla-desktop/pkg/rancher-desktop/main/extensions/manager.ts
import { ChildProcessByStdio, spawn, SpawnOptionsWithStdioTuple } from 'child_process';
import http from 'http';
import path from 'path';
import { Readable } from 'stream';

import Electron, { IpcMainEvent, IpcMainInvokeEvent, net } from 'electron';
import _ from 'lodash';
import semver from 'semver';

import { ExtensionErrorImpl, ExtensionImpl } from './extensions';
import { createRecipeExtension, RecipeExtensionImpl } from './recipeExtension';
import {
  Extension, ExtensionErrorCode, ExtensionManager, SpawnOptions, SpawnResult,
} from './types';

import { fetchMarketplaceData, invalidateMarketplaceCache } from './marketplaceData';
import type { ContainerEngineClient } from '@pkg/backend/containerClient';
import { ContainerEngine, Settings } from '@pkg/config/settings';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import mainEvents from '@pkg/main/mainEvents';
import type { IpcMainEvents, IpcMainInvokeEvents, IpcRendererEvents } from '@pkg/typings/electron-ipc';
import { parseImageReference } from '@pkg/utils/dockerUtils';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { executable } from '@pkg/utils/resources';
import { RecursiveReadonly } from '@pkg/utils/typeUtils';

const console = Logging.extensions;
const ipcMain = getIpcMainProxy(console);
let manager: ExtensionManager | undefined;

type IpcMainEventListener<K extends keyof IpcMainEvents> =
  (event: IpcMainEvent, ...args: Parameters<IpcMainEvents[K]>) => void;

type IpcMainEventHandler<K extends keyof IpcMainInvokeEvents> =
  (event: IpcMainInvokeEvent, ...args: Parameters<IpcMainInvokeEvents[K]>) =>
    Promise<ReturnType<IpcMainInvokeEvents[K]>> | ReturnType<IpcMainInvokeEvents[K]>;

type ReadableChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * EXTENSION_APP is a fake extension ID that signifies the other end is not a
 * real extension, but instead is our main application.
 */
const EXTENSION_APP = '<app>';

/**
 * Flag to indicate that we've already spawned the process to wait for the main
 * process to shut down; this is global because we may need to restart the
 * extension manager on settings change, but we should not spawn a new copy of
 * the process watcher in that case.
 */
let mainProcessWatcherInitialized = false;

export class ExtensionManagerImpl implements ExtensionManager {
  /**
   * Known extensions.  Keyed by the image (excluding tag), then the tag.
   * @note Items here are not necessarily installed, but all installed
   * extensions are listed.
   */
  protected extensions: Record<string, Record<string, ExtensionImpl>> = {};

  /**
   * Recipe-based extensions keyed by slug, then version.
   * These use an installation.yaml manifest instead of Docker image metadata.
   */
  protected recipeExtensions: Record<string, Record<string, RecipeExtensionImpl>> = {};

  constructor(client: ContainerEngineClient, containerd: boolean) {
    this.client = client;
    this.containerd = containerd;
  }

  readonly client: ContainerEngineClient;

  /**
   * Flag indicating whether we're using containerd.
   * @note avoid if possible.
   */
  readonly containerd: boolean;

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
   * Processes from extensions created in spawnStreaming() that may still be
   * running.
   */
  protected processes: Record<string, WeakRef<ReadableChildProcess>> = {};

  async init(config: RecursiveReadonly<Settings>) {
    if (process.platform !== 'win32' && !mainProcessWatcherInitialized) {
      // If we're not running on Windows, spawn a process that waits for this
      // process to exit and then kill all processes in this process group.
      // We don't do this on Windows as we have a different (job-based)
      // implementation there that will trigger automatically when we exit,
      // based on `wsl-helper process spawn`.
      const proc = spawn(
        executable('rdctl'),
        ['internal', 'process', 'wait-kill', `--pid=${ process.pid }`],
        { stdio: ['ignore', await console.fdStream, await console.fdStream], detached: true });

      proc.unref();
      mainProcessWatcherInitialized = true;
    }

    // Handle events from the renderer process.
    this.setMainListener('extensions/open-external', (...[, url]) => {
      Electron.shell.openExternal(url);
    });

    this.setMainListener('extensions/spawn/kill', (event, execId) => {
      const extensionId = this.getExtensionIdFromEvent(event);
      const fullExecId = `${ extensionId }:${ execId }`;
      const process = this.processes[fullExecId]?.deref();

      process?.kill('SIGTERM');
      console.debug(`Killed ${ fullExecId }: ${ process }`);
    });

    this.setMainListener('extensions/spawn/streaming', async(event, options) => {
      switch (options.scope) {
      case 'host':
        return this.execStreaming(event, options, await this.spawnHost(event, options));
      case 'docker-cli':
        return this.execStreaming(event, options, await this.spawnDockerCli(event, options));
      case 'container':
        return this.execStreaming(event, options, await this.spawnContainer(event, options));
      default:
        console.error(`Unexpected scope ${ options.scope }`);
        throw new Error(`Unexpected scope ${ options.scope }`);
      }
    });

    this.setMainHandler('extensions/spawn/blocking', async(event, options) => {
      switch (options.scope) {
      case 'host':
        return this.execBlocking(await this.spawnHost(event, options));
      case 'docker-cli':
        return this.execBlocking(await this.spawnDockerCli(event, options));
      case 'container':
        return this.execBlocking(await this.spawnContainer(event, options));
      default:
        console.error(`Unexpected scope ${ options.scope }`);
        throw new Error(`Unexpected scope ${ options.scope }`);
      }
    });

    this.setMainHandler('extensions/ui/show-open', (event, options) => {
      const window = Electron.BrowserWindow.fromWebContents(event.sender);

      if (window) {
        return Electron.dialog.showOpenDialog(window, options);
      }

      return Electron.dialog.showOpenDialog(options);
    });

    this.setMainListener('extensions/ui/toast', (event, level, message) => {
      const title = {
        success: 'Success',
        warning: 'Warning',
        error:   'Error',
      }[level];
      const urgency = ({
        success: 'low',
        warning: 'normal',
        error:   'critical',
      } as const)[level];

      const notification = new Electron.Notification({
        title,
        body: message,
        urgency,
      });

      notification.show();
    });

    this.setMainHandler('extensions/vm/http-fetch', async(event, config) => {
      const extensionId = this.getExtensionIdFromEvent(event);

      if (!extensionId) {
        // Sender frame has gone away, no need to fetch anymore.
        return {
          statusCode: -1, name: 'Request aborted', message: 'Request aborted',
        };
      }
      if (extensionId === EXTENSION_APP) {
        throw new Error('HTTP fetch from main app not implemented yet');
      }

      const extension = await this.getExtension(extensionId) as ExtensionImpl;
      let url: URL;

      if (/^[^:/]*:/.test(config.url)) {
        // the URL is absolute, use as-is.
        url = new URL(config.url);
      } else {
        // given a relative URL, we need to figure out how to connect to the backend.
        const port = await extension.getBackendPort();

        if (!port) {
          return Promise.reject(new Error('Could not find backend port'));
        }
        url = new URL(config.url, `http://127.0.0.1:${ port }`);
      }

      if (!url.hostname) {
        console.error(`Fetching from extension backend service not implemented yet (${ extensionId } fetching ${ url })`);

        return Promise.reject(new Error('Could not fetch from backend'));
      }

      const options: RequestInit = {
        method:  config.method,
        headers: config.headers ?? {},
        body:    config.data,
      };
      const response = await net.fetch(url.toString(), options);

      return {
        statusCode: response.status, name: http.STATUS_CODES[response.status] ?? 'Unknown', message: await response.text(),
      };
    });

    // Import image for port forwarding
    await this.client.runClient(
      ['image', 'load', '--input', path.join(paths.resources, 'rdx-proxy.tar')],
      console, { namespace: ExtensionImpl.extensionNamespace });

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

      if (!(await this.isSupported(repo))) {
        // If this extension is explicitly not supported, don't re-install it.
        console.log(`Uninstalling unsupported extension ${ repo }:${ tag }`);
        mainEvents.emit('settings-write', { application: { extensions: { installed: { [repo]: undefined } } } });
        mainEvents.emit('extensions/ui/uninstall', repo);
        continue;
      }

      tasks.push((async(repo: string, tag: string) => {
        const id = `${ repo }:${ tag }`;

        try {
          return await (await this.getExtension(id)).install(allowList);
        } catch (ex) {
          console.error(`Failed to install extension ${ id }`, ex);
          mainEvents.emit('settings-write', { application: { extensions: { installed: { [repo]: undefined } } } });
        }
      })(repo, tag));
    }
    await Promise.all(tasks);

    // Start all installed extensions (recipe extensions run their start command).
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

  /**
   * Check if the given extension is supported.
   * @note This is a temporary hack while we have a hard-coded list of
   * extensions.
   */
  protected async isSupported(repo: string): Promise<boolean> {
    if (!this.containerd) {
      return true;
    }

    const desired = parseImageReference(repo);

    if (!desired) {
      return false;
    }

    if (!this.#supportedExtensions) {
      const supported: Record<string, boolean> = {};
      const marketplaceData = await fetchMarketplaceData();

      for (const item of marketplaceData) {
        const slug = parseImageReference(item.slug);

        if (!slug) {
          continue;
        }

        supported[new URL(slug.name, slug.registry).toString()] = item.containerd_compatible;
      }

      this.#supportedExtensions = supported;
    }

    const ref = new URL(desired.name, desired.registry).toString();

    return this.#supportedExtensions[ref] ?? true;
  }

  #supportedExtensions: Record<string, boolean> | undefined;

  async getExtension(image: string, options: { preferInstalled?: boolean } = {}): Promise<Extension> {
    let [, imageName, tag] = /^(.*):(.*?)$/.exec(image) ?? ['', image, undefined];

    // The build process uses an older TypeScript that can't infer imageName correctly.
    imageName ??= image;

    const preferInstalled = options?.preferInstalled ?? true;

    // Check if this is a recipe-based extension (has an installable URL in the catalog)
    const recipeExt = await this.getRecipeExtension(imageName, tag, preferInstalled);

    if (recipeExt) {
      return recipeExt;
    }

    // Fall back to legacy Docker-image-based extension
    this.extensions[imageName] ??= {};
    const extGroup = this.extensions[imageName];

    if (tag) {
      extGroup[tag] ||= new ExtensionImpl(imageName, tag, this.client);

      return extGroup[tag];
    }

    if (preferInstalled) {
      for (const ext of Object.values(extGroup)) {
        if (await ext.isInstalled()) {
          return ext;
        }
      }
    }

    tag = await this.findBestVersion(imageName);
    extGroup[tag] ||= new ExtensionImpl(imageName, tag, this.client);

    return extGroup[tag];
  }

  /**
   * Check the marketplace catalog for a recipe-based extension.
   * Returns a RecipeExtensionImpl if the catalog entry has an installable URL,
   * otherwise returns undefined to fall back to the legacy flow.
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

  /**
   * Given an image name (without tag), calculate the best tag to use as an
   * extension image.
   */
  protected async findBestVersion(imageName: string): Promise<string> {
    const tags = await this.client.getTags(
      imageName, { namespace: ExtensionImpl.extensionNamespace });
    const tagArray = Array.from(tags);

    console.debug(`Got tags: ${ JSON.stringify(tagArray) }`);

    // Select the highest semver tag, if available.
    // We try a couple ways to determine semver in the tag.
    const vers: [semver.SemVer, string][] = [];

    for (const converter of [
      // semver.parse, possibly stripping "v" or "v." prefix.
      (tag: string) => semver.parse(tag.replace(/^v\.?/i, '')),
      // semver.coerce (grab the first digits in the string)
      semver.coerce,
    ]) {
      vers.push(...tagArray.map(tag => [converter(tag), tag] as const)
        .filter(([v]) => v) as [semver.SemVer, string][]);
      if (vers.length > 0) {
        break;
      }
    }

    const newest = vers.sort(([l], [r]) => semver.compare(l, r)).pop()?.[1];

    if (newest) {
      return newest;
    }

    // Use the "latest" tag, if available.
    if (tags.has('latest')) {
      return 'latest';
    }

    // No relevant tags are available.
    throw new ExtensionErrorImpl(
      ExtensionErrorCode.FILE_NOT_FOUND,
      `Could not detect relevant version for image "${ imageName }"`);
  }

  async getInstalledExtensions() {
    // Get a list of all extensions (legacy + recipe), installed or not.
    const legacyExts: Extension[] = Object.values(this.extensions).flatMap(group => Object.values(group));
    const recipeExts: Extension[] = Object.values(this.recipeExtensions).flatMap(group => Object.values(group));
    const allExts = [...legacyExts, ...recipeExts];

    // Calculate if each is installed (in parallel).
    const states = await Promise.all(allExts.map(async ext => [ext, await ext.isInstalled()] as const));

    // Return the extensions that are marked as installed.
    return states.filter(([, state]) => state).map(([ext]) => ext);
  }

  /**
   * Given an IpcMainEvent, return the extension ID associated with it.
   */
  protected getExtensionIdFromEvent(event: IpcMainEvent | IpcMainInvokeEvent): string | undefined {
    const { senderFrame } = event;

    if (!senderFrame) {
      return;
    }

    const origin = new URL(senderFrame.origin);

    return origin.protocol === 'app:' ? EXTENSION_APP : Buffer.from(origin.hostname, 'hex').toString();
  }

  /** Spawn a process in the host context. */
  protected async spawnHost(event: IpcMainEvent | IpcMainInvokeEvent, options: SpawnOptions): Promise<ReadableChildProcess> {
    const extensionId = this.getExtensionIdFromEvent(event);

    if (!extensionId) {
      throw new Error(`spawning process from a closed window`);
    }
    if (extensionId === EXTENSION_APP) {
      throw new Error(`spawning a process from the main application is not implemented yet: ${ options.command.join(' ') }`);
    }

    const extension = await this.getExtension(extensionId) as ExtensionImpl;

    if (!extension) {
      throw new Error(`Could not find calling extension ${ extensionId }`);
    }

    const command = [...options.command];
    const finalOptions: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'> = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   {},
      ..._.pick(options, ['cwd', 'env']),
    };
    const binDir = path.join(paths.resources, process.platform, 'bin');

    finalOptions.env = _.merge({}, process.env, finalOptions.env);
    finalOptions.env.PATH = finalOptions.env.PATH + path.delimiter + binDir;

    command[0] = path.join(extension.dir, 'bin', command[0]);
    if (process.platform === 'win32') {
      // Use wsl-helper to launch the executable
      command.unshift(executable('wsl-helper'), 'process', 'spawn', `--parent=${ process.pid }`, '--');
    }

    return spawn(command[0], command.slice(1), finalOptions);
  }

  /** Spawn a process in the docker-cli context. */
  protected async spawnDockerCli(event: IpcMainEvent | IpcMainInvokeEvent, options: SpawnOptions): Promise<ReadableChildProcess> {
    const extensionId = this.getExtensionIdFromEvent(event);

    if (!extensionId) {
      throw new Error(`Spawning docker client from closed sender frame`);
    }
    if (extensionId !== EXTENSION_APP) {
      const extension = await this.getExtension(extensionId) as ExtensionImpl;

      if (!extension) {
        throw new Error(`Could not find calling extension ${ extensionId }`);
      }
    }

    return this.client.runClient(
      // For docker compatibility, strip quotes for any arguments.
      options.command.map(arg => (/^(["'])(.*)\1$/.exec(arg) ?? ['', '', arg])[2]),
      'stream',
      _.pick(options, ['cwd', 'env', 'namespace']));
  }

  /** Spawn a process in the container context. */
  protected async spawnContainer(event: IpcMainEvent | IpcMainInvokeEvent, options: SpawnOptions): Promise<ReadableChildProcess> {
    const extensionId = this.getExtensionIdFromEvent(event);

    if (!extensionId) {
      throw new Error(`Spawning docker client from closed sender frame`);
    }
    if (extensionId === EXTENSION_APP) {
      throw new Error(`Spawning a container command is not implemented for the main app: ${ options.command.join(' ') }`);
    }
    const extension = await this.getExtension(extensionId) as ExtensionImpl;

    if (!extension) {
      return Promise.reject(new Error(`Could not find calling extension ${ extensionId }`));
    }

    return extension.composeExec(options);
  }

  /**
   * Execute a process on behalf of an extension, returning a promise that will
   * be resolved when the process completes.
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
   * Execute a process on behalf of an extension, with the output fed back to
   * the extension via callbacks.
   */
  protected execStreaming(event: IpcMainEvent, options: SpawnOptions, process: ReadableChildProcess) {
    const extensionId = this.getExtensionIdFromEvent(event);
    const fullId = `${ extensionId }:${ options.execId }`;

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
   * Recipe extensions will run their `commands.start` from installation.yaml;
   * legacy extensions are a no-op.
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

    if (!(await ext.isInstalled())) {
      throw new Error(`Extension ${ id } is not installed`);
    }
    await ext.start();
  }

  async stopExtension(id: string): Promise<void> {
    const ext = await this.getExtension(id);

    if (!(await ext.isInstalled())) {
      throw new Error(`Extension ${ id } is not installed`);
    }
    await ext.stop();
  }

  async getExtensionStatus(id: string): Promise<'running' | 'stopped' | 'not_installed'> {
    const ext = await this.getExtension(id);

    if (!(await ext.isInstalled())) {
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
  manager = new ExtensionManagerImpl(client, cfg.containerEngine.name === ContainerEngine.CONTAINERD);

  await manager.init(cfg);
}

export default getExtensionManager;
