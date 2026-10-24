import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const b64url = value => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export class LicenseError extends Error { constructor(code, message) { super(message); this.code = code; } }

export function verifyLicenseToken(token, publicKeyBase64, { now = Date.now(), seatCount = 0 } = {}) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) throw new LicenseError('invalid', 'License key format is invalid.');
  let header, claims;
  try { header = JSON.parse(b64url(parts[0])); claims = JSON.parse(b64url(parts[1])); } catch { throw new LicenseError('invalid', 'License key payload is invalid.'); }
  if (header.alg !== 'EdDSA' || header.typ !== 'SULLA-SERVER-LICENSE' || header.v !== 1) throw new LicenseError('invalid', 'License key type is not supported.');
  if (!publicKeyBase64) throw new LicenseError('unconfigured', 'License verification public key is not configured.');
  let key;
  try { key = createPublicKey({ key: Buffer.from(publicKeyBase64.replace(/\s/g, ''), 'base64'), format: 'der', type: 'spki' }); } catch { throw new LicenseError('unconfigured', 'License verification public key is invalid.'); }
  if (!verifySignature(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]))) throw new LicenseError('invalid', 'License signature is invalid.');
  if (claims.iss !== 'sulla-cloud' || claims.typ !== 'server-license' || !claims.licenseId || !claims.orgId || !claims.serverId) throw new LicenseError('invalid', 'License claims are incomplete.');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) throw new LicenseError('lapsed', 'License has expired. Enter a renewed key.');
  if (claims.seatLimit != null && seatCount > claims.seatLimit) throw new LicenseError('seat_limit', `This license allows ${claims.seatLimit} seats; the server has ${seatCount}.`);
  return claims;
}

export class ServerLicenseManager {
  constructor({ stateFile, publicKey, cloudUrl, fetchImpl = fetch, seatCount = async () => 0, now = () => Date.now() }) {
    this.stateFile = stateFile; this.publicKey = publicKey; this.cloudUrl = cloudUrl?.replace(/\/$/, ''); this.fetch = fetchImpl; this.seatCount = seatCount; this.now = now;
    this.state = { status: 'missing', message: 'Enter a Sulla Server license key.', lastCheckIn: null, nextCheckIn: null, failures: 0 };
  }
  async init() { try { this.state = JSON.parse(await readFile(this.stateFile, 'utf8')); await this.evaluate(); } catch (error) { if (error?.code !== 'ENOENT') this.state = { ...this.state, status: 'invalid', message: 'Saved license state could not be read.' }; } return this.status(); }
  async save() { await mkdir(dirname(this.stateFile), { recursive: true }); const tmp = `${this.stateFile}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 }); await rename(tmp, this.stateFile); }
  async evaluate() { if (!this.state.token) return this.status(); try { this.state.claims = verifyLicenseToken(this.state.token, this.publicKey, { now: this.now(), seatCount: await this.seatCount() }); this.state.status = 'active'; this.state.message = 'License active.'; } catch (error) { this.state.status = error.code || 'invalid'; this.state.message = error.message; } return this.status(); }
  status() { const { token: _token, ...safe } = this.state; return { ...safe, active: this.state.status === 'active', catalogAllowed: this.state.status === 'active' && this.state.claims?.features?.includes('use_cases') === true }; }
  async activate(token) { this.state = { token: String(token || '').trim(), status: 'invalid', message: '', lastCheckIn: null, nextCheckIn: null, failures: 0 }; await this.evaluate(); if (this.state.status !== 'active') throw new LicenseError(this.state.status, this.state.message); await this.save(); return this.status(); }
  async checkIn({ force = false } = {}) {
    await this.evaluate(); if (this.state.status !== 'active') return this.status();
    if (!force && this.state.nextCheckIn && Date.parse(this.state.nextCheckIn) > this.now()) return this.status();
    try {
      const seatCount = await this.seatCount();
      const response = await this.fetch(`${this.cloudUrl}/cloud-servers/v1/check-in`, { method: 'POST', headers: { Authorization: `Bearer ${this.state.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ seatCount }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { this.state.status = body.state === 'lapsed' ? 'lapsed' : 'invalid'; this.state.message = body.error === 'seat_limit_exceeded' ? `Seat limit exceeded (${seatCount}/${body.seatLimit}).` : 'Cloud rejected this license key.'; }
      else { this.state.status = 'active'; this.state.message = 'License active.'; this.state.lastCheckIn = new Date(this.now()).toISOString(); this.state.failures = 0; this.state.nextCheckIn = new Date(this.now() + 86_400_000).toISOString(); }
    } catch { const failures = (this.state.failures || 0) + 1; this.state.failures = failures; this.state.message = 'License is valid offline; Cloud check-in will retry.'; this.state.nextCheckIn = new Date(this.now() + Math.min(86_400_000, 60_000 * 2 ** Math.min(failures, 10))).toISOString(); }
    await this.save(); return this.status();
  }
  requireCatalog() { const status = this.status(); if (!status.catalogAllowed) throw new LicenseError(status.status, status.message || 'An active license is required for the Use Cases catalog.'); return status; }
  fingerprint() { return this.state.token ? createHash('sha256').update(this.state.token).digest('hex').slice(0, 16) : null; }
}
