// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export function composerSendState(running: boolean, canSend: boolean): 'dim' | 'ready' | 'queue' {
  if (running) return 'queue';
  return canSend ? 'ready' : 'dim';
}

export function activateComposerSend(
  canSend: boolean,
  send: () => void,
): void {
  if (canSend) send();
}
