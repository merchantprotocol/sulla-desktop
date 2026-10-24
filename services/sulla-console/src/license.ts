// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY_MS = 86_400_000;

function b64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export class LicenseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface LicenseClaims {
  iss: string;
  typ: string;
  licenseId: string;
  orgId: string;
  serverId: string;
  edition?: string;
  exp: number;
  seatLimit?: number | null;
  features?: string[];
}

interface LicenseState {
  token?: string;
  claims?: LicenseClaims;
  status: string;
  message: string;
  lastCheckIn: string | null;
  nextCheckIn: string | null;
  failures: number;
}

interface LicenseManagerOptions {
  stateFile: string;
  publicKey: string;
  cloudUrl: string;
  fetchImpl?: typeof fetch;
  seatCount: () => Promise<number>;
  now?: () => number;
}

function parseToken(parts: string[]): { header: Record<string, unknown>; claims: LicenseClaims } {
  try {
    return {
      header: JSON.parse(b64url(parts[0]).toString()),
      claims: JSON.parse(b64url(parts[1]).toString()),
    };
  } catch {
    throw new LicenseError('invalid', 'License key payload is invalid.');
  }
}

function licensePublicKey(publicKeyBase64: string) {
  if (!publicKeyBase64) throw new LicenseError('unconfigured', 'License verification public key is not configured.');
  try {
    const der = Buffer.from(publicKeyBase64.replace(/\s/g, ''), 'base64');
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new LicenseError('unconfigured', 'License verification public key is invalid.');
  }
}

export function verifyLicenseToken(
  token: string,
  publicKeyBase64: string,
  { now = Date.now(), seatCount = 0 } = {},
): LicenseClaims {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) throw new LicenseError('invalid', 'License key format is invalid.');
  const { header, claims } = parseToken(parts);
  if (header.alg !== 'EdDSA' || header.typ !== 'SULLA-SERVER-LICENSE' || header.v !== 1) {
    throw new LicenseError('invalid', 'License key type is not supported.');
  }
  const key = licensePublicKey(publicKeyBase64);
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!verifySignature(null, signed, key, b64url(parts[2]))) {
    throw new LicenseError('invalid', 'License signature is invalid.');
  }
  const complete = claims.iss === 'sulla-cloud' && claims.typ === 'server-license' &&
    Boolean(claims.licenseId && claims.orgId && claims.serverId);
  if (!complete) throw new LicenseError('invalid', 'License claims are incomplete.');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) {
    throw new LicenseError('lapsed', 'License has expired. Enter a renewed key.');
  }
  if (claims.seatLimit != null && seatCount > claims.seatLimit) {
    throw new LicenseError('seat_limit', `This license allows ${claims.seatLimit} seats; the server has ${seatCount}.`);
  }
  return claims;
}

export class ServerLicenseManager {
  private state: LicenseState = {
    status: 'missing',
    message: 'Enter a Sulla Server license key.',
    lastCheckIn: null,
    nextCheckIn: null,
    failures: 0,
  };

  constructor(private readonly options: LicenseManagerOptions) {}

  private get now() {
    return this.options.now ?? Date.now;
  }

  private get fetchImpl() {
    return this.options.fetchImpl ?? fetch;
  }

  private get cloudBase() {
    return this.options.cloudUrl.replace(/\/$/, '');
  }

  async init() {
    try {
      this.state = JSON.parse(await readFile(this.options.stateFile, 'utf8'));
      await this.evaluate();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.state = { ...this.state, status: 'invalid', message: 'Saved license state could not be read.' };
      }
    }
    return this.status();
  }

  private async save() {
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    const tmp = `${this.options.stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(tmp, this.options.stateFile);
  }

  async evaluate() {
    if (!this.state.token) return this.status();
    try {
      const seatCount = await this.options.seatCount();
      this.state.claims = verifyLicenseToken(this.state.token, this.options.publicKey, { now: this.now(), seatCount });
      this.state.status = 'active';
      this.state.message = 'License active.';
    } catch (error) {
      this.state.status = error instanceof LicenseError ? error.code : 'invalid';
      this.state.message = error instanceof Error ? error.message : 'License is invalid.';
    }
    return this.status();
  }

  status() {
    const claims = this.state.claims;
    const active = this.state.status === 'active';
    return {
      valid: active,
      edition: claims?.edition ?? 'community',
      masked: this.fingerprint(),
      seats: claims?.seatLimit ?? null,
      registeredTo: claims?.orgId ?? null,
      serverId: claims?.serverId ?? null,
      nextCheckIn: this.state.nextCheckIn,
      state: this.state.status,
      message: this.state.message,
      catalogAllowed: active && claims?.features?.includes('use_cases') === true,
    };
  }

  async activate(token: string) {
    this.state = {
      token: String(token || '').trim(),
      status: 'invalid',
      message: '',
      lastCheckIn: null,
      nextCheckIn: null,
      failures: 0,
    };
    await this.evaluate();
    if (this.state.status !== 'active') throw new LicenseError(this.state.status, this.state.message);
    await this.save();
    return this.status();
  }

  async checkIn({ force = false } = {}) {
    await this.evaluate();
    if (this.state.status !== 'active') return this.status();
    const notDue = this.state.nextCheckIn && Date.parse(this.state.nextCheckIn) > this.now();
    if (!force && notDue) return this.status();
    try {
      const seatCount = await this.options.seatCount();
      const response = await this.fetchImpl(`${this.cloudBase}/cloud-servers/v1/check-in`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.state.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatCount }),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.ok) {
        this.state.status = 'active';
        this.state.message = 'License active.';
        this.state.lastCheckIn = new Date(this.now()).toISOString();
        this.state.failures = 0;
        this.state.nextCheckIn = new Date(this.now() + DAY_MS).toISOString();
      } else {
        this.state.status = body.state === 'lapsed' ? 'lapsed' : 'invalid';
        this.state.message = body.error === 'seat_limit_exceeded'
          ? `Seat limit exceeded (${seatCount}/${body.seatLimit}).`
          : 'Cloud rejected this license key.';
      }
    } catch {
      const failures = (this.state.failures || 0) + 1;
      const backoff = Math.min(DAY_MS, 60_000 * 2 ** Math.min(failures, 10));
      this.state.failures = failures;
      this.state.message = 'License is valid offline; Cloud check-in will retry.';
      this.state.nextCheckIn = new Date(this.now() + backoff).toISOString();
    }
    await this.save();
    return this.status();
  }

  requireCatalog() {
    const status = this.status();
    if (!status.catalogAllowed) throw new LicenseError(status.state, status.message);
    return status;
  }

  async cloudRequest(path: string, init: RequestInit = {}) {
    this.requireCatalog();
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new LicenseError('invalid', 'Cloud catalog path is invalid.');
    }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.state.token}`);
    return this.fetchImpl(`${this.cloudBase}${path}`, { ...init, headers, redirect: 'error' });
  }

  fingerprint() {
    if (!this.state.token) return null;
    return createHash('sha256').update(this.state.token).digest('hex').slice(0, 16);
  }
}
