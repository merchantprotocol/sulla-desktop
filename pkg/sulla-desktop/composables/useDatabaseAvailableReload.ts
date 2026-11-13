// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getCurrentScope, onScopeDispose } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * Re-runs `reload` when the main process broadcasts `database:available`.
 *
 * Guarded read handlers (see main/DatabaseReadGuard.ts) return an empty list
 * while Postgres is still starting; a page that loaded during that window
 * calls this once in setup so it refills itself when the database is back.
 * The listener is removed with the component/effect scope.
 */
export function useDatabaseAvailableReload(reload: () => unknown, label = 'renderer'): void {
  const listener = () => {
    Promise.resolve()
      .then(reload)
      .catch(err => console.warn(`[${ label }] reload after database:available failed:`, err));
  };

  ipcRenderer.on('database:available', listener);
  if (getCurrentScope()) onScopeDispose(() => ipcRenderer.removeListener('database:available', listener));
}
