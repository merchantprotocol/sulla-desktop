// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const DEFAULT_CHAT_HEARTBEAT_MESSAGE =
  'Heartbeat: give me a short update on what moved since your last update, then keep working on anything unfinished. If nothing is in flight, reply in one line.';

export const CHAT_HEARTBEAT_MAX_DURATION_MS = 6 * 60 * 60_000;
/** A delegated job is woken as a whole turn, so its heartbeat may not fire more often than this. */
export const CHAT_HEARTBEAT_JOB_MIN_INTERVAL_MINUTES = 5;

export type ChatHeartbeatSetBy = 'agent' | 'human' | 'manager';

export interface ChatHeartbeatConfig {
  intervalMinutes: number | null;
  message:         string;
  /** Original activation time; persisted in tab state and delegated-job records. */
  startedAt?:      number | null;
  /** Original six-hour deadline; re-registration must never extend it. */
  expiresAt?:      number | null;
  setBy?:          ChatHeartbeatSetBy;
}

export interface ChatHeartbeatStatus extends ChatHeartbeatConfig {
  threadId: string;
  enabled:  boolean;
  nextAt:   number | null;
  pending:  boolean;
  startedAt: number | null;
  expiresAt: number | null;
  // True while the target graph is running — no regular countdown beat.
  paused?:  boolean;
}

export interface ChatHeartbeatBeat {
  threadId:        string;
  createdAt:       number;
  intervalMinutes: number;
  message:         string;
  autoOff?:        boolean;
}

export function defaultChatHeartbeatConfig(): ChatHeartbeatConfig {
  return {
    intervalMinutes: null,
    message:          DEFAULT_CHAT_HEARTBEAT_MESSAGE,
    startedAt:        null,
    expiresAt:        null,
    setBy:             'human',
  };
}

export function normalizeChatHeartbeatConfig(input?: Partial<ChatHeartbeatConfig> | null): ChatHeartbeatConfig {
  const rawInterval = Number(input?.intervalMinutes);
  const intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.min(rawInterval, 24 * 60)
    : null;
  const message = typeof input?.message === 'string' && input.message.trim()
    ? input.message.trim()
    : DEFAULT_CHAT_HEARTBEAT_MESSAGE;

  const setBy = input?.setBy === 'agent' || input?.setBy === 'manager' ? input.setBy : 'human';
  const startedAt = typeof input?.startedAt === 'number' && Number.isFinite(input.startedAt) ? input.startedAt : null;
  const expiresAt = typeof input?.expiresAt === 'number' && Number.isFinite(input.expiresAt) ? input.expiresAt : null;

  return { intervalMinutes, message, startedAt, expiresAt, setBy };
}
