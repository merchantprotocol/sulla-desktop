// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import Electron from 'electron';

import mainEvents from '@pkg/main/mainEvents';
import { RestartState } from '@pkg/main/restartState';
import type { RestartKind } from '@pkg/main/restartState';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

type UpdateInstaller = () => void;

const state = new RestartState();
let updateInstaller: UpdateInstaller | undefined;

function request(kind: RestartKind, installer?: UpdateInstaller): boolean {
  if (!state.request(kind)) {
    console.warn(`[Restart] Ignoring duplicate ${ kind } request; ${ state.kind } restart is already in progress`);

    return false;
  }
  updateInstaller = installer;
  console.log(`[Restart] ${ kind } restart requested; beginning coordinated shutdown`);
  mainEvents.emit('restarting');
  Electron.app.quit();

  return true;
}

/** Request a normal relaunch after the shared graceful shutdown finishes. */
export function requestApplicationRestart(): boolean {
  return request('application');
}

/** Request updater installation after the shared graceful shutdown finishes. */
export function requestUpdateRestart(installer: UpdateInstaller): boolean {
  return request('update', installer);
}

export function isRestartRequested(): boolean {
  return state.kind !== undefined;
}

export function restartKind(): RestartKind | undefined {
  return state.kind;
}

/**
 * Finish a coordinated restart. This is deliberately idempotent because both
 * the graceful path and its hard deadline can reach it.
 */
export function completeRestart(): void {
  if (!state.beginCompletion()) return;

  if (state.kind === 'update') {
    if (!updateInstaller) {
      console.error('[Restart] Update installer is missing; falling back to an application relaunch');
    } else {
      console.log('[Restart] Shutdown complete; handing off to updater with force-run-after enabled');
      try {
        updateInstaller();

        return;
      } catch (error) {
        console.error('[Restart] Updater handoff failed; falling back to an application relaunch', error);
      }
    }
  }

  console.log('[Restart] Shutdown complete; registering relaunch and exiting old instance');
  Electron.app.relaunch();
  // app.exit avoids another cancellable before-quit pass. Electron releases
  // the single-instance lock before launching the registered replacement.
  Electron.app.exit(0);
}
