// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** The slice of the renderer IPC this navigator needs (swappable in tests). */
export interface MainWindowIpc {
  send(channel: string, ...args: any[]): void;
}

/**
 * Opens tabs (Passwords, Integrations, Docker…) in the main Sulla window. The
 * main process forwards the request, so this works from any renderer.
 */
export class MainWindowNavigator {
  private static instance: MainWindowNavigator | undefined;

  /** The window-wide navigator, created on first use. */
  static get shared(): MainWindowNavigator {
    MainWindowNavigator.instance ??= new MainWindowNavigator(ipcRenderer as unknown as MainWindowIpc);

    return MainWindowNavigator.instance;
  }

  constructor(private readonly ipc: MainWindowIpc) {}

  /** Open a tab (Passwords, Integrations…) in the main Sulla window. */
  openMainTab(mode: string): void {
    this.ipc.send('preferences/open-main-tab', mode);
  }

  /** Open the Docker tab (containers, images, snapshots), optionally on one of its pages. */
  openDockerTab(section?: string): void {
    this.ipc.send('dashboard-open', section);
  }
}

/** @deprecated use MainWindowNavigator.shared.openMainTab */
export const openMainTab = (mode: string): void => MainWindowNavigator.shared.openMainTab(mode);

/** @deprecated use MainWindowNavigator.shared.openDockerTab */
export const openDockerTab = (section?: string): void => MainWindowNavigator.shared.openDockerTab(section);
