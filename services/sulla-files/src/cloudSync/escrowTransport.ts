// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { generateTransportKeyPair, transportUnwrap, type TransportEnvelope } from './envelope.js';

const TRANSPORT_TTL_MS = 120_000;
const MAX_OUTSTANDING = 16;

interface PendingTransport { privateKey:CryptoKey; expiresAt:number }

export class EscrowTransportError extends Error {
  readonly status = 409;
  readonly code = 'ESCROW_TRANSPORT_REJECTED';
}

/**
 * Single-use P-256 recipient pairs for Vault → Files key transport. A pair is
 * forgotten the moment it is consumed or expires, so a replayed or late
 * transport envelope can never be unwrapped.
 */
export class EscrowTransportRequests {
  private readonly pending = new Map<string, PendingTransport>();

  constructor(private readonly now:() => number = () => Date.now()) {}

  async issue():Promise<{ requestId:string; recipientPublicKey:string }> {
    this.prune();
    if (this.pending.size >= MAX_OUTSTANDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest) this.pending.delete(oldest);
    }
    const requestId = randomUUID();
    const pair = await generateTransportKeyPair();
    this.pending.set(requestId, { privateKey: pair.privateKey, expiresAt: this.now() + TRANSPORT_TTL_MS });
    return { requestId, recipientPublicKey: pair.publicKey };
  }

  /** Removes the pair before unwrapping, so even a failed unwrap burns it. */
  async unwrap(requestId:string, transport:TransportEnvelope, vaultId:string, vaultEpoch:number):Promise<Uint8Array> {
    const entry = typeof requestId === 'string' ? this.pending.get(requestId) : undefined;
    if (entry) this.pending.delete(requestId);
    if (!entry || entry.expiresAt <= this.now()) throw new EscrowTransportError('Escrow key request is unknown, expired or already used');
    try {
      return await transportUnwrap(transport, entry.privateKey, requestId, vaultId, vaultEpoch);
    } catch {
      throw new EscrowTransportError('Escrow key transport could not be opened');
    }
  }

  private prune():void {
    const now = this.now();
    for (const [requestId, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(requestId);
    }
  }
}
