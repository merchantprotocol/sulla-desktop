// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { type Clock, SystemClock } from '@sulla/foundation';

import { SessionBindProof } from './SessionBindProof';

/** The slice of the domain `DeviceIdentityService` (`desktopDeviceIdentity()`) a session-bind proof needs. */
export interface SessionBindIdentity {
  deviceId(): Promise<{ value: string }>;
  signBytes(payload: Uint8Array): Promise<string>;
}

/** Proof headers for one session-creating request; `{}` when there is no proof to send. */
export interface SessionBindHeaders {
  headersFor(requestPath: string, body: string): Promise<Record<string, string>>;
}

/** No proof: the transport's wire format before session binding. */
export class NoSessionBind implements SessionBindHeaders {
  async headersFor(): Promise<Record<string, string>> {
    return {};
  }
}

/**
 * Signs `SessionBindProof`s with this install's device key. Best effort by design: an identity that can't be loaded,
 * fails to sign or doesn't answer within `timeoutMs` yields no headers (Cloud then creates an unbound session) and one
 * warning without secrets. It never fails or blocks a sign-in.
 */
export class SessionBindSigner implements SessionBindHeaders {
  constructor(
    private readonly identity: () => Promise<SessionBindIdentity>,
    private readonly clock: Clock,
    private readonly warn: (message: string) => void,
    private readonly timeoutMs = 3_000,
  ) {}

  /** The process-wide Desktop device identity (loaded lazily, so importing this never touches ~/.sulla). */
  static forDesktop(warn: (message: string) => void): SessionBindSigner {
    return new SessionBindSigner(
      async() => (await import('./DesktopDeviceIdentity')).desktopDeviceIdentity(),
      new SystemClock(),
      warn,
    );
  }

  async headersFor(requestPath: string, body: string): Promise<Record<string, string>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ this.timeoutMs } ms`)), this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([this.sign(requestPath, body), timeout]);
    } catch (error) {
      const reason = error instanceof Error ? `${ error.name }: ${ error.message }` : 'unknown error';
      this.warn(`[SessionBindSigner] Sending ${ SessionBindProof.pathOf(requestPath) } without a device session proof (${ reason })`);

      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  private async sign(requestPath: string, body: string): Promise<Record<string, string>> {
    const identity = await this.identity();
    const deviceId = (await identity.deviceId()).value;
    const proof = SessionBindProof.frame(deviceId, Math.floor(this.clock.now().getTime() / 1000), requestPath, body);

    return proof.headers(await identity.signBytes(proof.bytes()));
  }
}
