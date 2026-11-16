// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Wraps an async loader so overlapping calls are skipped while one is in flight.
 * Polled loaders that shell out (docker ps/stats/df) otherwise stack a new child
 * process every tick whenever the previous call is slow.
 */
export class SingleFlight<T> {
  private running = false;

  constructor(private readonly fn: () => Promise<T>) {}

  async run(): Promise<T | undefined> {
    if (this.running) {
      return undefined;
    }
    this.running = true;
    try {
      return await this.fn();
    } finally {
      this.running = false;
    }
  }
}

/** @deprecated use `new SingleFlight(fn)` and call `.run()` */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
  const flight = new SingleFlight(fn);

  return () => flight.run();
}
