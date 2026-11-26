// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface AbortTarget { abort(): void; }

/** Forwards a durable task-stop signal into the currently executing run. */
export class AbortSignalBridge {
  private readonly abort = () => this.target.abort();

  constructor(private readonly signal: AbortSignal, private readonly target: AbortTarget) {
    if (signal.aborted) this.abort();
    else signal.addEventListener('abort', this.abort, { once: true });
  }

  dispose(): void { this.signal.removeEventListener('abort', this.abort); }
}
