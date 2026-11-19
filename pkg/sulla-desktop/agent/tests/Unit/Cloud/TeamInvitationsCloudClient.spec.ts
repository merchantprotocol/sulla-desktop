// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { TeamInvitationsCloudClient } from '../../../../main/TeamInvitationsCloudClient';

const NOW = new Date('2026-11-18T12:00:00Z');
const FUTURE = '2026-11-25T12:00:00Z';
const PAST = '2026-11-01T12:00:00Z';

function clientReturning(status: number, body: unknown = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  const request = async (method: string, path: string) => {
    calls.push({ method, path });
    return new Response(JSON.stringify(body), { status });
  };
  return { client: new TeamInvitationsCloudClient(request as never, () => NOW), calls };
}

describe('TeamInvitationsCloudClient', () => {
  it('lists only pending, unexpired invitations', async () => {
    // risk: data accuracy; accepted, revoked, expired and past-expiry invites must not show as pending
    const { client } = clientReturning(200, {
      invitations: [
        { id: 'i-1', email: 'devin@example.com', status: 'pending', expiresAt: FUTURE },
        { id: 'i-2', email: 'old@example.com', status: 'expired', expiresAt: PAST },
        { id: 'i-3', email: 'done@example.com', status: 'accepted', expiresAt: FUTURE },
        { id: 'i-4', email: 'gone@example.com', status: 'revoked', expiresAt: FUTURE },
        { id: 'i-5', email: 'stale@example.com', status: 'pending', expiresAt: PAST },
      ],
    });
    expect(await client.listPending('team-1')).toEqual([{ id: 'i-1', email: 'devin@example.com', expiresAt: FUTURE }]);
  });

  it('treats 403 as no invitations section rather than an error', async () => {
    // risk: permissions; non-admins are refused by the server and must see no section and no banner
    const { client } = clientReturning(403, { error: 'forbidden' });
    expect(await client.listPending('team-1')).toEqual([]);
  });

  it('treats 404 as no invitations section rather than an error', async () => {
    // risk: permissions; an unknown team must not surface as a failure in the People list
    const { client } = clientReturning(404, { error: 'not found' });
    expect(await client.listPending('team-1')).toEqual([]);
  });

  it('throws on other server failures so the caller can hide the section', async () => {
    // risk: data accuracy; a 500 must not be read as an empty list that hides real invites silently
    const { client } = clientReturning(500, {});
    await expect(client.listPending('team-1')).rejects.toThrow(/Invitations unavailable \(500\)/);
  });

  it('never returns a token or invite link, and encodes the team id in the path', async () => {
    // risk: privacy and permissions; invite tokens must never reach the renderer
    const { client, calls } = clientReturning(200, {
      invitations: [{ id: 'i-1', email: 'devin@example.com', status: 'pending', expiresAt: FUTURE, token: 'secret-token', inviteUrl: 'https://x/invite/secret' }],
    });
    const [invite] = await client.listPending('team/1');
    expect(Object.keys(invite).sort()).toEqual(['email', 'expiresAt', 'id']);
    expect(calls).toEqual([{ method: 'GET', path: '/teams/team%2F1/invitations' }]);
  });
});
