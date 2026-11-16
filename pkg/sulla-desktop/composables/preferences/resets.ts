// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** The slice of the renderer IPC the reset flow needs (swappable in tests). */
export interface FactoryResetIpc {
  invoke(channel: string, ...args: any[]): Promise<any>;
  send(channel: string, ...args: any[]): void;
}

/** Asks the user, then factory-resets Sulla Desktop through the main process. */
export class FactoryResetService {
  private static instance: FactoryResetService | undefined;

  /** The window-wide service, created on first use. */
  static get shared(): FactoryResetService {
    FactoryResetService.instance ??= new FactoryResetService(ipcRenderer as unknown as FactoryResetIpc);

    return FactoryResetService.instance;
  }

  constructor(private readonly ipc: FactoryResetIpc) {}

  /** Ask, then remove all containers, images, settings and Sulla data on this computer. */
  async confirmFactoryReset(): Promise<void> {
    const result = await this.ipc.invoke('show-message-box', {
      type:            'warning',
      title:           'Factory reset',
      message:         'Reset Sulla Desktop to factory settings?',
      detail:          'This removes all containers, images, settings and Sulla data on this computer, ' +
        'then quits Sulla. It can’t be undone.',
      checkboxLabel:   'Keep cached system images',
      checkboxChecked: false,
      buttons:         ['Factory reset', 'Cancel'],
      cancelId:        1,
    });

    if (result.response === 0) {
      this.ipc.send('factory-reset', !!result.checkboxChecked);
    }
  }
}

/** @deprecated use FactoryResetService.shared.confirmFactoryReset */
export const confirmFactoryReset = (): Promise<void> => FactoryResetService.shared.confirmFactoryReset();
