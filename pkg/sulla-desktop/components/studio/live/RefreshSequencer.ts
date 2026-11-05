// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export class RefreshSequencer {
  private latestRequested = 0;
  private inFlight: Promise<void> | undefined;

  request<T>(fetch: () => Promise<T>, apply: (result: T) => void, reject: () => void): Promise<void> {
    this.latestRequested += 1;
    if (!this.inFlight) {
      this.inFlight = this.drain(fetch, apply, reject).finally(() => {
        this.inFlight = undefined;
      });
    }

    return this.inFlight;
  }

  private async drain<T>(fetch: () => Promise<T>, apply: (result: T) => void, reject: () => void): Promise<void> {
    let ticket = 0;

    do {
      ticket = this.latestRequested;
      try {
        const result = await fetch();

        if (ticket === this.latestRequested) apply(result);
      } catch {
        if (ticket === this.latestRequested) reject();
      }
    } while (ticket !== this.latestRequested);
  }
}
