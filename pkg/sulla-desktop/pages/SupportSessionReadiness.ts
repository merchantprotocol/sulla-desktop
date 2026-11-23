// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type SupportSessionConnection = 'inactive' | 'unverified' | 'checking' | 'offline' | 'rpc-ready';

interface SessionBinding {
  id?: string;
  status?: string;
  user?: { id?: string };
  device?: { id?: string };
  acceptedBy?: string;
  approvedAt?: string;
  expiresAt?: string;
}

export class SupportSessionReadiness {
  binding(session: SessionBinding | null, expectedId: string, now: number): string | null {
    if (session?.id !== expectedId || session.status !== 'active' || !session.user?.id || !session.device?.id
      || !session.acceptedBy || !session.approvedAt || !session.expiresAt
      || !Number.isFinite(Date.parse(session.approvedAt)) || !(Date.parse(session.expiresAt) > now)) return null;

    return JSON.stringify([session.id, session.user.id, session.device.id, session.acceptedBy, session.approvedAt, session.expiresAt]);
  }

  connection(active: boolean, binding: string | null, presence: boolean | null | undefined,
    proof: { binding: string; validUntil: number } | null, now: number): SupportSessionConnection {
    if (!active) return 'inactive';
    if (!binding || presence === null) return 'unverified';
    if (presence === undefined) return 'checking';
    if (!presence) return 'offline';
    return proof?.binding === binding && proof.validUntil > now ? 'rpc-ready' : 'unverified';
  }
}
