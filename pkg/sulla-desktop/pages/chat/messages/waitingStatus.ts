// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Message, UserMessage } from '../models/Message';

/** After this long with nothing back from Sulla, the row says so and offers a way out. */
export const NO_RESPONSE_AFTER_MS = 60_000;

/**
 * The user message Sulla is still answering with nothing to show yet: the
 * chat is running and the newest message is the user's own. Anything Sulla
 * adds after it (thinking, a tool, text, a sub-agent card) ends the wait.
 */
export function waitingOn(messages: readonly Message[], running: boolean): { message: UserMessage; since: number } | null {
  if (!running) return null;
  let first = messages.length;
  while (first > 0 && messages[first - 1].kind === 'user') first--;
  if (first === messages.length) return null;

  // Messages sent while waiting (queued) don't restart the clock.
  return { message: messages[messages.length - 1] as UserMessage, since: messages[first].createdAt };
}

export function waitingLabel(elapsedMs: number): { text: string; stalled: boolean } {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const clock = `${ Math.floor(seconds / 60) }:${ String(seconds % 60).padStart(2, '0') }`;
  const stalled = elapsedMs >= NO_RESPONSE_AFTER_MS;

  return { text: stalled ? `No response from Sulla for ${ clock }` : `Sulla is working… ${ clock }`, stalled };
}
