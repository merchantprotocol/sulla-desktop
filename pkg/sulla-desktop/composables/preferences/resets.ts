// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** Ask, then remove all containers, images, settings and Sulla data on this computer. */
export async function confirmFactoryReset(): Promise<void> {
  const result = await ipcRenderer.invoke('show-message-box', {
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
    ipcRenderer.send('factory-reset', !!result.checkboxChecked);
  }
}
