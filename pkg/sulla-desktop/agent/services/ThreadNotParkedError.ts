// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Thrown by BackendGraphWebSocketService.wakeParkedAgent for a thread that
 * names no parked job — the one expected rejection JobHeartbeatDelivery
 * treats as "busy, retry later" rather than a real failure. Kept in its own
 * dependency-free module so JobHeartbeatDelivery.ts can `instanceof`-check it
 * without importing BackendGraphWebSocketService.ts and its Electron-heavy
 * transitive graph.
 */
export class ThreadNotParkedError extends Error {
  constructor(threadId: string) {
    super(`Thread ${ threadId } is not a parked agent job.`);
    this.name = 'ThreadNotParkedError';
  }
}
