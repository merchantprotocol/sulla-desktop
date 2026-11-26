// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type ChatTabActivityState = 'you' | 'stalled' | 'working' | 'quiet' | 'waiting' | 'idle';

export interface ChatTabActivitySnapshot {
  state:   ChatTabActivityState;
  detail?: string;
}

export type ChatTabActivityArgs = [tabId: string, running: boolean, activity?: ChatTabActivitySnapshot];

/** Validates the small, renderer-safe summary sent over the internal-tab IPC bridge. */
export function isChatTabActivitySnapshot(value: unknown): value is ChatTabActivitySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ChatTabActivitySnapshot>;
  if (!['you', 'stalled', 'working', 'quiet', 'waiting', 'idle'].includes(snapshot.state as string)) return false;
  return snapshot.detail === undefined || (typeof snapshot.detail === 'string' && snapshot.detail.length <= 240);
}
