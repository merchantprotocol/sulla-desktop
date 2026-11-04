// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VaultBrokerError } from '@pkg/vault-broker';

const HEARTBEAT_RETRY_DELAYS_MS = [5_000, 15_000] as const;

export interface HeartbeatScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export class DeviceHeartbeatRetrier {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  constructor(private readonly scheduler: HeartbeatScheduler, private readonly attempt: () => Promise<{ ok: boolean; transient: boolean }>) {}
  async run(): Promise<void> {
    const generation = ++this.generation;
    if (this.retryTimer) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.tryAttempt(generation, 0);
  }
  stop(): void {
    this.generation++;
    if (this.retryTimer) this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
  private async tryAttempt(generation: number, retryIndex: number): Promise<void> {
    const result = await this.attempt();
    if (result.ok || !result.transient || generation !== this.generation || retryIndex >= HEARTBEAT_RETRY_DELAYS_MS.length) return;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      void this.tryAttempt(generation, retryIndex + 1);
    }, HEARTBEAT_RETRY_DELAYS_MS[retryIndex]);
  }
}

export class DeviceFailureDescriber {
  describe(error: unknown): { detail: string; status: number; transient: boolean } {
    if (error instanceof VaultBrokerError) {
      const hint = `${ error.code } ${ error.reason ?? '' }`;
      const stage = /refresh|oauth/i.test(hint) ? 'token_refresh' : /upstream/i.test(hint) ? 'upstream' : 'local_broker';
      const reason = error.reason ? ` reason=${ this.safeToken(error.reason) }` : '';
      const terminal = error.code === 'vault_locked' || error.status === 423 || error.status === 401 || /signed.?out|credential_field_missing/i.test(error.code);
      return { detail: `code=${ this.safeToken(error.code) } status=${ error.status } stage=${ stage }${ reason }`, status: error.status, transient: !terminal };
    }
    if (error instanceof Error && /Waiting for the vault to be unlocked/i.test(error.message)) {
      return { detail: 'code=vault_locked status=423 stage=local_broker', status: 423, transient: false };
    }
    if (error instanceof Error && /Sign in to Sulla Cloud again|Not signed in/i.test(error.message)) {
      return { detail: 'code=signed_out status=401 stage=token_refresh', status: 401, transient: false };
    }
    const networkCode = error instanceof Error && /^net::[A-Z_]+$/.test(error.message) ? error.message : 'network_error';
    return { detail: `code=${ this.safeToken(networkCode) } status=0 stage=upstream`, status: 0, transient: true };
  }
  private safeToken(value: string): string { return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : 'unknown'; }
}
