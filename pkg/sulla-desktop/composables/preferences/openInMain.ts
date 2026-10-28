// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * Open a tab (Passwords, Integrations…) in the main Sulla window. The main
 * process forwards the request, so this works from any renderer.
 */
export function openMainTab(mode: string): void {
  ipcRenderer.send('preferences/open-main-tab', mode);
}

/** Open the Docker tab (containers, images, snapshots), optionally on one of its pages. */
export function openDockerTab(section?: string): void {
  ipcRenderer.send('dashboard-open', section);
}
