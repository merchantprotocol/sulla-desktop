// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This module contains code for handling auto-updates.
 */

import fs from 'fs';
import os from 'os';
import timers from 'timers';

import { GenericServerOptions } from 'builder-util-runtime';
import Electron from 'electron';
import {
  AppImageUpdater, MacUpdater, AppUpdater, ProgressInfo, UpdateInfo,
} from 'electron-updater';
import { ElectronAppAdapter } from 'electron-updater/out/ElectronAppAdapter';
import yaml from 'yaml';

import { updateEvents } from './UpdateManager';
import { readUpdateChannelState, recordPendingUpdate, recordUpdateFailure } from './channelState';
import { launchMacInstaller, stageMacUpdate, type StagedMacUpdate } from './macSelfInstall';

import { Settings } from '@pkg/config/settings';
import mainEvent from '@pkg/main/mainEvents';
import { isRestartRequested, requestUpdateRestart } from '@pkg/main/restartCoordinator';
import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';

const console = Logging.update;

/** State describes how for into start up we are. */
enum State {
  /** Startup hasn't been attempted yet. */
  UNCONFIGURED,
  /** No update configuration; updates are not available. */
  NO_CONFIGURATION,
  /** Updater has been configured, but no checks have been triggered. */
  CONFIGURED,
  /** We have triggered at least one update check. */
  CHECKED,
  /** An update is being downloaded; suppress checks. */
  DOWNLOADING,
  /** An update is pending; we should not check again. */
  UPDATE_PENDING,
  /** An error has occurred configuring the updater. */
  ERROR,
}
let state: State = State.UNCONFIGURED;

let autoUpdater: AppUpdater;
/** When we should check for updates next. */
let updateTimer: NodeJS.Timeout;
/** The update interval reported by the server. */
let updateInterval = 0;

let macStagingPromise: Promise<StagedMacUpdate> | undefined;

export interface UpdateState {
  configured: boolean;
  available:  boolean;
  downloaded: boolean;
  error?:     Error;
  info?:      AnyUpdateInfo;
  progress?:  ProgressInfo;
}
const updateState: UpdateState = {
  configured: false, available: false, downloaded: false,
};

Electron.ipcMain.on('update-state', () => {
  window.send('update-state', updateState);
});

Electron.ipcMain.on('update-apply', () => {
  installQueuedUpdate().catch(error => console.error('[update] install request failed', error));
});

/**
 * Quit the app and install a queued update.
 * No-op if the updater isn't configured or updates are force-disabled.
 */
export async function installQueuedUpdate(): Promise<void> {
  if (!autoUpdater || process.env.SULLA_FORCE_UPDATES_ENABLED) {
    console.warn('[update] installQueuedUpdate: updater not configured or disabled');

    return;
  }
  if (!updateState.info?.version || os.platform() === 'darwin' && !macStagingPromise || os.platform() !== 'darwin' && !updateState.downloaded) {
    console.warn('[update] installQueuedUpdate: no checksum-verified download is pending');
    return;
  }
  if (isRestartRequested()) {
    console.warn('[update] installQueuedUpdate: another restart is already in progress');
    return;
  }

  try {
    if (os.platform() === 'darwin') {
      const staged = await macStagingPromise;

      // Spawn before coordinated shutdown: if this fails, the app remains alive.
      await launchMacInstaller(staged);
    }
  } catch (error) {
    // Staging failures are already recorded by stageVerifiedMacUpdate. A helper
    // spawn failure happens later, so persist it here while leaving the app up.
    if (os.platform() === 'darwin' && updateState.downloaded) {
      const message = error instanceof Error ? error.message : String(error);
      const channelState = recordUpdateFailure(updateState.info.version, message);

      console.error(`[update] mac installer spawn failed: ${ message }`);
      state = State.ERROR;
      updateState.error = new Error(message);
      updateState.downloaded = false;
      window.send('update-state', updateState);
      updateEvents.emit('raw-state', updateState);
      updateEvents.emit('install-failed', channelState.lastUpdateResult);
    }
    return;
  }
  if (!updateState.downloaded) {
    console.warn('[update] installQueuedUpdate: staging has not completed');
    return;
  }

  // electron-updater emits update-downloaded only after its DownloadedUpdateHelper
  // has validated the artifact against latest-mac.yml's sha512.
  recordPendingUpdate(updateState.info.version);
  requestUpdateRestart(() => {
    if (os.platform() === 'darwin') {
      console.info('[update] mac installer handoff');
      Electron.app.exit(0);
    } else {
      autoUpdater.quitAndInstall(false, true);
    }
  });
}

function stageVerifiedMacUpdate(zipPath: string, targetVersion: string): Promise<StagedMacUpdate> {
  if (macStagingPromise) return macStagingPromise;

  macStagingPromise = new Promise<StagedMacUpdate>((resolve, reject) => {
    const startedAt = Date.now();
    console.info('[update] mac staging started');
    stageMacUpdate(zipPath, targetVersion).then((staged) => {
      console.info(`[update] mac staged in ${ Math.round((Date.now() - startedAt) / 1000) }s`);
      resolve(staged);
    }).catch((error: Error) => {
      if (error) {
        const message = (error.message || String(error)).split('\n', 1)[0]
          .replace(/https?:\/\/\S+/g, '').trim().slice(0, 240)
          || 'Sulla could not stage the update.';
        console.error(`[update] mac staging failed: ${ message }`);
        const channelState = recordUpdateFailure(targetVersion, message);
        updateState.error = new Error(message);
        updateState.downloaded = false;
        window.send('update-state', updateState);
        updateEvents.emit('raw-state', updateState);
        updateEvents.emit('install-failed', channelState.lastUpdateResult);
        reject(error);
      }
    });
  });

  return macStagingPromise;
}

/**
 * Update info from the feed. The generic provider sends plain UpdateInfo; the
 * optional fields stay so the renderer's update views keep their shape.
 */
type AnyUpdateInfo = UpdateInfo & { nextUpdateTime?: number; unsupportedUpdateAvailable?: boolean };

/** How often to re-check; the generic feed doesn't say. */
const DEFAULT_UPDATE_INTERVAL = 6 * 60 * 60 * 1000;

/**
 * Return a new AppUpdater; if no update configuration is available, returns
 * undefined. The configuration is app-update.yml, which electron-builder writes
 * from the publish block in packaging/electron-builder.yml (dev builds read
 * dev-app-update.yml instead): electron-updater's generic provider reading
 * latest-mac.yml from the releases bucket.
 */
async function getUpdater(): Promise<AppUpdater | undefined> {
  let updater: AppUpdater;

  try {
    const { appUpdateConfigPath } = new ElectronAppAdapter();
    let fileContents : string;

    try {
      fileContents = await fs.promises.readFile(appUpdateConfigPath, { encoding: 'utf8' });
    } catch (ex) {
      if ((ex as NodeJS.ErrnoException).code === 'ENOENT') {
        console.debug(`No update configuration found in ${ appUpdateConfigPath }`);

        return undefined;
      }
      throw ex;
    }
    const parsed: GenericServerOptions = yaml.parse(fileContents);
    const channelState = readUpdateChannelState();
    const configured = new URL(parsed.url.endsWith('/') ? parsed.url : `${ parsed.url }/`);
    const feedUrl = channelState.pinnedVersion
      ? new URL(`../../releases/v${ channelState.pinnedVersion }/`, configured).toString()
      : channelState.channel === 'nightly'
        ? new URL('../nightly/', configured).toString()
        : configured.toString();
    const options: GenericServerOptions = { ...parsed, url: feedUrl };

    switch (os.platform()) {
    case 'darwin':
      updater = new MacUpdater(options);
      break;
    case 'linux':
      updater = new AppImageUpdater(options);
      break;
    default:
      throw new Error(`Don't know how to create updater for platform ${ os.platform() }`);
    }
  } catch (e) {
    console.error(e);
    throw e;
  }

  if (process.env.SULLA_FORCE_UPDATES_ENABLED) {
    updater.forceDevUpdateConfig = true;
  }

  updater.logger = console;
  updater.autoDownload = true;
  const channelState = readUpdateChannelState();
  updater.allowDowngrade = !!channelState.pinnedVersion || (channelState.channel === 'lts' && /-/.test(Electron.app.getVersion()));
  updater.autoInstallOnAppQuit = false;
  updater.on('error', (error) => {
    console.debug('update: error:', error);
    updateState.error = error;
    updateState.downloaded = false;
    window.send('update-state', updateState);
    updateEvents.emit('raw-state', updateState);
  });
  updater.on('checking-for-update', () => {
    console.debug('update: checking for update');
    updateState.available = false;
    updateState.downloaded = false;
    updateEvents.emit('checking');
  });
  updater.on('update-available', (info) => {
    console.debug('update: update available:', info);
    updateState.available = true;
    updateState.info = info;
    updateState.downloaded = state === State.UPDATE_PENDING;
    window.send('update-state', updateState);
    updateEvents.emit('raw-state', updateState);
  });
  updater.on('update-not-available', (info) => {
    console.debug('update: not available:', info);
    updateState.available = false;
    updateState.info = info;
    updateState.downloaded = false;
    window.send('update-state', updateState);
    updateEvents.emit('raw-state', updateState);
  });
  updater.on('download-progress', (progress) => {
    if (state === State.CHECKED || state === State.UPDATE_PENDING) {
      state = State.DOWNLOADING;
    }
    updateState.progress = progress;
    updateState.downloaded = false;
    window.send('update-state', updateState);
    updateEvents.emit('raw-state', updateState);
  });
  updater.on('update-downloaded', (info) => {
    console.debug('update: downloaded:', info);
    updateState.info = info;
    updateState.error = undefined;
    // Prevent the updater from downloading the update again; it will clobber
    // the existing download.
    updater.autoDownload = false;

    if (os.platform() !== 'darwin') {
      if (state === State.DOWNLOADING) state = State.UPDATE_PENDING;
      updateState.downloaded = true;
      window.send('update-state', updateState);
      updateEvents.emit('raw-state', updateState);
      return;
    }

    const downloadedFile = (info as typeof info & { downloadedFile?: string }).downloadedFile;

    if (!downloadedFile) {
      const error = new Error('The verified macOS update path was not provided.');
      const channelState = recordUpdateFailure(info.version, error.message);
      updateState.error = error;
      updateState.downloaded = false;
      window.send('update-state', updateState);
      updateEvents.emit('raw-state', updateState);
      updateEvents.emit('install-failed', channelState.lastUpdateResult);
      return;
    }
    updateState.downloaded = false;
    window.send('update-state', updateState);
    updateEvents.emit('raw-state', updateState);
    stageVerifiedMacUpdate(downloadedFile, info.version).then(() => {
      state = State.UPDATE_PENDING;
      updateState.downloaded = true;
      updateState.error = undefined;
      window.send('update-state', updateState);
      updateEvents.emit('raw-state', updateState);
    }).catch(() => {
      state = State.ERROR;
      macStagingPromise = undefined;
    });
  });

  return updater;
}

mainEvent.on('settings-update', (settings: Settings) => {
  if (settings.application.updater.enabled && state === State.CONFIGURED) {
    // We have a configured updater, but haven't done the actual check yet.
    // This means the setting was disabled when we configured the updater.
    // Start checking now.
    doInitialUpdateCheck();
  }
});


/** Drop the cached updater so a changed channel/feed takes effect immediately. */
export function reconfigureUpdater(): void {
  if (updateTimer) timers.clearTimeout(updateTimer);
  updateTimer = undefined as unknown as NodeJS.Timeout;
  autoUpdater?.removeAllListeners();
  autoUpdater = undefined as unknown as AppUpdater;
  macStagingPromise = undefined;
  state = State.UNCONFIGURED;
  updateState.configured = false;
  updateState.available = false;
  updateState.downloaded = false;
  updateState.error = undefined;
  updateState.info = undefined;
  updateState.progress = undefined;
}

/**
 * Set up the updater and, when enabled, start checking for updates.
 * Installing a downloaded update is always the user's call (installQueuedUpdate).
 *
 * @param enabled Whether updates are enabled
 * @returns Whether the update is being installed (always false).
 */
export default async function setupUpdate(enabled: boolean): Promise<boolean> {
  console.debug(`Setting up updater... enabled=${ enabled }`);
  if (state === State.UNCONFIGURED) {
    try {
      const newUpdater = await getUpdater();

      if (!newUpdater?.isUpdaterActive()) {
        console.debug(`No update configuration found.`);
        state = State.NO_CONFIGURATION;

        return false;
      }
      autoUpdater = newUpdater;
    } catch (ex) {
      state = State.ERROR;
      throw ex;
    }
  }
  updateState.configured = true;
  window.send('update-state', updateState);
  state = State.CONFIGURED;

  if (!enabled) {
    return false;
  }

  try {
    const result = await doInitialUpdateCheck();

    state = State.CHECKED;

    return result;
  } catch (ex) {
    // If the initial update check fails, don't prevent application startup.
    state = State.ERROR;
    console.error(`Error setting up updater:`, ex);

    return false;
  }
}

/**
 * Do the initial update check.
 * @precondition autoUpdater has been set up.
 * @returns Whether the update is being installed (always false).
 */
async function doInitialUpdateCheck(): Promise<boolean> {
  triggerUpdateCheck();

  return false;
}

/**
 * Trigger an update check, and set up the timer to re-check again later.
 */
async function triggerUpdateCheck() {
  if (state !== State.DOWNLOADING) {
    const result = await autoUpdater.checkForUpdates();

    if (!result) {
      // App update is disabled (likely because the app is not packaged).
      return;
    }

    const updateInfo: AnyUpdateInfo = result.updateInfo;
    const givenTimeDelta = updateInfo.nextUpdateTime
      ? updateInfo.nextUpdateTime - Date.now()
      : DEFAULT_UPDATE_INTERVAL;

    // Enforce at least one minute between checks, even if the server is reporting
    // bad times.
    updateInterval = Math.max(givenTimeDelta, 60_000);
  }

  // regardless of whether we actually made the check, schedule the next check.

  if (updateTimer) {
    timers.clearTimeout(updateTimer);
  }
  updateTimer = timers.setTimeout(triggerUpdateCheck, updateInterval);
}

export { supportUpdateApi } from './UpdateManager';
export type { UpdateChannel, UpdateChannelSetter } from './channelState';
