// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DevicesPanelError, type DevicesPanelErrorCode } from './DevicesPanelService';

export type DevicesPanelFailureCode = DevicesPanelErrorCode | 'not_signed_in' | 'cloud_unreachable' | 'blocked_by_vault';

export interface DevicesPanelFailure {
  ok:    false;
  code:  DevicesPanelFailureCode;
  error: string;
}

/** A Cloud request that threw before any HTTP answer. Carries the `METHOD /path` it was for. */
export class DevicesRequestFailure extends Error {
  constructor(readonly request: string, readonly original: unknown) {
    super(`Sulla Cloud request ${ request } failed`);
    this.name = 'DevicesRequestFailure';
  }
}

export interface DevicesPanelWarningSink {
  warn(message: string, original: unknown): void;
}

const NETWORK_PATTERN = /net::ERR_|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|timed? ?out/i;
const SIGNED_OUT_PATTERN = /not signed in|sign in to sulla cloud/i;
const NOT_ALLOWLISTED_PATTERN = /not allowlisted/i;

/**
 * Turns anything thrown by the Devices panel into the failure the renderer shows.
 * Every failure is logged with its real cause and request before it is mapped,
 * so a support log shows what actually happened.
 */
export class DevicesPanelErrorMapper {
  constructor(private readonly sink: DevicesPanelWarningSink = { warn: (message, original) => console.warn(message, original) }) {}

  map(error: unknown): DevicesPanelFailure {
    const request = this.requestOf(error);
    const cause = error instanceof DevicesRequestFailure ? error.original : error;
    const failure = this.classify(cause);

    this.sink.warn(`[devices-panel] ${ request ?? 'unknown request' } failed (${ failure.code }):`, cause);

    return failure;
  }

  private requestOf(error: unknown): string | undefined {
    if (error instanceof DevicesRequestFailure) return error.request;
    if (error instanceof DevicesPanelError) return error.request;

    return undefined;
  }

  private classify(cause: unknown): DevicesPanelFailure {
    if (cause instanceof DevicesPanelError) {
      if (cause.httpStatus !== undefined) {
        return failure('cloud_error', `Sulla Cloud returned an error (HTTP ${ cause.httpStatus }).`);
      }

      return failure(cause.code, cause.message);
    }
    if (this.isVaultRefusal(cause)) {
      return failure('blocked_by_vault', 'Sulla\'s vault blocked this Cloud request. Update Sulla, and report it if it continues.');
    }

    const message = messageOf(cause);
    if (SIGNED_OUT_PATTERN.test(message)) return failure('not_signed_in', 'Sign in to Sulla Cloud to see your devices.');
    if (this.isNetworkFailure(cause)) return failure('cloud_unreachable', 'Couldn\'t reach Sulla Cloud. Check your connection and try again.');

    return failure('cloud_error', 'Sulla Cloud couldn\'t finish this request. Try again.');
  }

  private isVaultRefusal(error: unknown): boolean {
    const record = error as { name?: unknown; code?: unknown; status?: unknown } | null;
    if (!record || typeof record !== 'object') return false;
    if (record.code === 'policy_denied') return true;
    if (NOT_ALLOWLISTED_PATTERN.test(messageOf(error))) return true;

    return record.name === 'VaultBrokerError' && record.status === 403;
  }

  private isNetworkFailure(error: unknown): boolean {
    const codes = [codeOf(error), codeOf((error as { cause?: unknown } | null)?.cause)];

    return codes.some(code => code !== undefined && NETWORK_PATTERN.test(code)) || NETWORK_PATTERN.test(messageOf(error));
  }
}

function failure(code: DevicesPanelFailureCode, error: string): DevicesPanelFailure {
  return { ok: false, code, error };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;

  return typeof code === 'string' ? code : undefined;
}
