// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export function newVoiceTurnId(): string {
  return `vt_${ Date.now().toString(36) }_${ crypto.randomUUID().slice(0, 8) }`;
}

/** Content-free voice diagnostics. Never pass transcript/audio/text here. */
export function voiceTrace(turnId: string, stage: string, data: Record<string, unknown> = {}): void {
  if (!turnId) return;
  const entry = { turnId, stage, ts: new Date().toISOString(), ...data };

  console.log('[VoiceTrace]', entry);
  ipcRenderer.send('voice-trace', entry);
}
