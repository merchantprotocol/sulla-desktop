/**
 * Secure desktop channel — the desktop's verification rules. Pure and
 * side-effect free so every rule is unit tested.
 *
 * A remote client (the Sulla Cloud dashboard in a browser, later Sulla
 * Mobile) holds its own Ed25519 key. Before it can do anything, the owner
 * approves that key AT THIS DESKTOP by comparing a 6-digit pairing code
 * shown in both places. After that, every command is a `signed` frame:
 *
 *   signed = JSON.stringify({ v: 1, deviceId, clientId, ts, nonce, body })
 *   sig    = Ed25519(clientKey, signed)
 *
 * The cloud relay stamps `from.userId/clientId` from the single-use ticket
 * it admitted the socket with. The desktop accepts a frame only when ALL of:
 *   1. from.userId is the Sulla Cloud user this desktop is signed in as;
 *   2. the clientId is approved here and matches both the stamp and the
 *      signed payload (clientId = hash of the approved public key);
 *   3. the signature verifies against the approved key;
 *   4. the payload is addressed to THIS device;
 *   5. ts is within ±2 minutes and the nonce has not been seen (no replay);
 *   6. body.type is on the allowlist.
 *
 * Consequence: neither a stolen cloud token nor a compromised cloud relay
 * can make this desktop run anything. Only a key the owner approved while
 * sitting at this machine can.
 */

import crypto from 'crypto';

export const FRAME_WINDOW_MS = 2 * 60 * 1000;
export const REMOTE_BODY_TYPES = new Set(['chat', 'inject', 'cancel', 'companion_request']);

export interface ApprovedClient {
  clientId:   string;
  publicKey:  string; // base64 raw Ed25519
  label:      string;
  surface:    string;
  approvedAt: string;
  lastUsedAt?: string;
}

export interface ClientFrameEnvelope {
  type:       'client_frame';
  kind:       'signed' | 'pair_request';
  from:       { userId?: string; clientId?: string; surface?: string };
  signed?:    string;
  sig?:       string;
  publicKey?: string;
  label?:     string;
}

export interface VerifiedCommand {
  clientId: string;
  body:     Record<string, any> & { type: string };
}

export function clientIdFromPublicKey(publicKeyB64: string): string {
  const raw = Buffer.from(publicKeyB64, 'base64');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * 6-digit code shown on both the desktop dialog and the browser. Bound to
 * this device and the exact key, so a code seen for one request is useless
 * for any other key or machine.
 */
export function pairingCode(deviceId: string, publicKeyB64: string): string {
  const h = crypto.createHash('sha256').update(`sulla-pair-v1|${ deviceId }|${ publicKeyB64 }`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function isRawEd25519Key(publicKeyB64: unknown): publicKeyB64 is string {
  if (typeof publicKeyB64 !== 'string' || publicKeyB64.length > 64) return false;
  try { return Buffer.from(publicKeyB64, 'base64').length === 32; } catch { return false; }
}

function ed25519Verify(publicKeyB64: string, message: string, sigB64: string): boolean {
  try {
    const key = crypto.createPublicKey({
      key:    { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyB64, 'base64').toString('base64url') },
      format: 'jwk',
    });
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message), key, sig);
  } catch {
    return false;
  }
}

/** Remembers nonces for the replay window. */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}

  /** Returns false if the nonce was already used. */
  claim(nonce: string, now = Date.now()): boolean {
    if (this.seen.size > this.max) this.prune(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + FRAME_WINDOW_MS * 2);
    return true;
  }

  private prune(now: number) {
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    // Still full (flood inside the window): drop oldest. Their ts will be
    // outside the window before they could be replayed anyway.
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
  }
}

export type VerifyResult = { ok: true; command: VerifiedCommand } | { ok: false; reason: string };

export function verifySignedFrame(
  env: ClientFrameEnvelope,
  ctx: {
    ownUserId:  string;
    deviceId:   string;
    approved:   (clientId: string) => ApprovedClient | undefined;
    nonces:     NonceCache;
    now?:       number;
  },
): VerifyResult {
  const now = ctx.now ?? Date.now();
  if (env?.type !== 'client_frame' || env.kind !== 'signed') return { ok: false, reason: 'not_signed_frame' };
  if (!ctx.ownUserId || env.from?.userId !== ctx.ownUserId) return { ok: false, reason: 'wrong_user' };
  const stampedClient = env.from?.clientId;
  if (!stampedClient) return { ok: false, reason: 'missing_client' };
  const client = ctx.approved(stampedClient);
  if (!client) return { ok: false, reason: 'client_not_approved' };
  if (typeof env.signed !== 'string' || typeof env.sig !== 'string' || env.signed.length > 256 * 1024) {
    return { ok: false, reason: 'malformed' };
  }
  if (!ed25519Verify(client.publicKey, env.signed, env.sig)) return { ok: false, reason: 'bad_signature' };

  let payload: any;
  try { payload = JSON.parse(env.signed); } catch { return { ok: false, reason: 'malformed' }; }
  if (payload?.v !== 1) return { ok: false, reason: 'unsupported_version' };
  if (payload.clientId !== stampedClient) return { ok: false, reason: 'client_mismatch' };
  if (payload.deviceId !== ctx.deviceId) return { ok: false, reason: 'wrong_device' };
  if (typeof payload.ts !== 'number' || Math.abs(now - payload.ts) > FRAME_WINDOW_MS) return { ok: false, reason: 'stale' };
  if (typeof payload.nonce !== 'string' || payload.nonce.length < 16 || payload.nonce.length > 64) return { ok: false, reason: 'bad_nonce' };
  const body = payload.body;
  if (!body || typeof body !== 'object' || !REMOTE_BODY_TYPES.has(body.type)) return { ok: false, reason: 'unsupported_command' };
  // Claim the nonce last so a rejected frame can't burn a legitimate one.
  if (!ctx.nonces.claim(`${ stampedClient }:${ payload.nonce }`, now)) return { ok: false, reason: 'replay' };

  return { ok: true, command: { clientId: stampedClient, body } };
}

/**
 * Validate a pairing request before showing the owner a dialog. The key
 * must hash to the clientId the relay stamped (so the browser can't ask
 * for approval of one key while connected under another id).
 */
export function checkPairRequest(env: ClientFrameEnvelope, ownUserId: string): { ok: true; clientId: string; publicKey: string; label: string; surface: string } | { ok: false; reason: string } {
  if (env?.type !== 'client_frame' || env.kind !== 'pair_request') return { ok: false, reason: 'not_pair_request' };
  if (!ownUserId || env.from?.userId !== ownUserId) return { ok: false, reason: 'wrong_user' };
  if (!isRawEd25519Key(env.publicKey)) return { ok: false, reason: 'bad_key' };
  const clientId = clientIdFromPublicKey(env.publicKey);
  if (env.from?.clientId !== clientId) return { ok: false, reason: 'client_mismatch' };
  const label = String(env.label || 'Unknown browser').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);
  return { ok: true, clientId, publicKey: env.publicKey, label, surface: env.from.surface === 'mobile' ? 'mobile' : 'web' };
}
