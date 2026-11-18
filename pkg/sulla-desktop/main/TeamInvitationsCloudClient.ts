// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { cloudRequest } from './cloud/cloudFetch';

/** A pending invitation as the People list shows it. Never carries a token or an invite link. */
export interface PendingInvitation { id: string; email: string; expiresAt: string }

/** The wire shape of one row from GET /teams/:teamId/invitations (sulla-workers InvitationResource.toArray). */
interface InvitationWire { id?: unknown; email?: unknown; status?: unknown; expiresAt?: unknown }

/**
 * Lists pending, unexpired invitations for an org. The endpoint is admin-only: a 403 or 404 means
 * this viewer may not see invitations, so the section stays hidden and nothing is reported as an error.
 */
export class TeamInvitationsCloudClient {
  constructor(
    private readonly request: typeof cloudRequest = cloudRequest,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listPending(teamId: string): Promise<PendingInvitation[]> {
    const response = await this.request('GET', `/teams/${encodeURIComponent(teamId)}/invitations`);
    if (response.status === 403 || response.status === 404) return [];
    if (!response.ok) throw new Error(`Invitations unavailable (${response.status})`);
    const body = await response.json() as { invitations?: InvitationWire[] };
    return (body.invitations ?? []).flatMap(row => this.toPending(row));
  }

  private toPending(row: InvitationWire): PendingInvitation[] {
    if (row.status !== 'pending') return [];
    if (typeof row.id !== 'string' || typeof row.email !== 'string' || !row.email.trim()) return [];
    const expiresAt = typeof row.expiresAt === 'string' ? row.expiresAt : '';
    if (!expiresAt || new Date(expiresAt).getTime() <= this.now().getTime()) return [];
    return [{ id: row.id, email: row.email.trim(), expiresAt }];
  }
}
