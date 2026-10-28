// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatController } from '../../controller/ChatController';

export function composerSendState(running: boolean, canSend: boolean): 'dim' | 'ready' | 'running' {
  if (running) return 'running';
  return canSend ? 'ready' : 'dim';
}

export function activateComposerSend(
  controller: ChatController,
  running: boolean,
  canSend: boolean,
  send: () => void,
): void {
  if (running) {
    controller.stop();
    return;
  }
  if (canSend) send();
}
