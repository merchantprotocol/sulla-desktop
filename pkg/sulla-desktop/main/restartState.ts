// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

export type RestartKind = 'application' | 'update';

/** Small deterministic state machine used by the process restart coordinator. */
export class RestartState {
  #kind: RestartKind | undefined;
  #completionStarted = false;

  request(kind: RestartKind): boolean {
    if (this.#kind) return false;
    this.#kind = kind;

    return true;
  }

  get kind(): RestartKind | undefined {
    return this.#kind;
  }

  beginCompletion(): boolean {
    if (!this.#kind || this.#completionStarted) return false;
    this.#completionStarted = true;

    return true;
  }
}
