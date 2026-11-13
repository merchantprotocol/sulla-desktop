// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Wrap an async loader so overlapping calls are skipped while one is in flight.
 * Polled loaders that shell out (docker ps/stats/df) otherwise stack a new child
 * process every tick whenever the previous call is slow.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
  let running = false;

  return async() => {
    if (running) {
      return undefined;
    }
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  };
}
