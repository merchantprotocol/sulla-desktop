// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface AiConnectionStatus { pending: string[]; connected: boolean; loading: boolean }

/** Short-lived cache that collapses concurrent status probes. */
export class FirstRunAiConnectionStatusCache {
  private cached?: { value: AiConnectionStatus; expiresAt: number };
  private inFlight?: Promise<AiConnectionStatus>;
  private generation = 0;

  constructor(private readonly read: () => Promise<AiConnectionStatus>, private readonly ttlMs = 30_000, private readonly now = () => Date.now()) {}

  get(): Promise<AiConnectionStatus> {
    if (this.cached && this.cached.expiresAt > this.now()) return Promise.resolve(this.cached.value);
    if (!this.inFlight) {
      const generation = this.generation;
      const request = this.read().then(value => {
        if (generation === this.generation) this.cached = { value, expiresAt: this.now() + this.ttlMs };
        return value;
      });
      this.inFlight = request;
      void request.then(
        () => { if (this.inFlight === request) this.inFlight = undefined; },
        () => { if (this.inFlight === request) this.inFlight = undefined; },
      );
    }
    return this.inFlight;
  }

  invalidate(): void { this.cached = undefined; this.generation++; this.inFlight = undefined }
}
