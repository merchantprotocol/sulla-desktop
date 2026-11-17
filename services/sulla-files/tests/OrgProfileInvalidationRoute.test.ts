// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { OrgCollectionRoutes } from '../src/routes/OrgCollectionRoutes.js';
import { ProfileIdentity } from '../src/ProfileIdentity.js';

type Handler = (request: unknown, response: unknown) => Promise<void>;

function captureRoute(profileCaches?: { invalidateProfile(profileId: string): void }) {
  const posts = new Map<string, Handler>();
  new OrgCollectionRoutes({ mode: 'desktop' }, {} as never, undefined, profileCaches)
    .register({ post: (path: string, handler: Handler) => posts.set(path, handler), put() {}, patch() {}, get() {}, delete() {} } as never);
  return posts.get('/v1/desktop/org-profiles/:profileId/invalidate')!;
}

function call(handler: Handler, profileId: string, remoteAddress: string, capability = true) {
  const state = { status: 0, body: undefined as unknown, sent: undefined as number | undefined };
  const response = {
    setHeader() {}, status(code: number) { state.status = code; return this }, json(body: unknown) { state.body = body; return this },
    sendStatus(code: number) { state.sent = code; return this },
  };
  const request = { params: { profileId }, socket: { remoteAddress }, filesIdentity: capability ? { kind: 'capability' } : undefined };
  return handler(request, response).then(() => state);
}

describe('profile invalidation route', () => {
  it('drops the named profile from loopback with a desktop capability', async () => {
    // risk: key lifecycle — sign-out must reach Files and erase that profile's keys.
    const calls: string[] = [];
    const handler = captureRoute({ invalidateProfile: id => calls.push(id) });
    const profileId = ProfileIdentity.fromCloudUserId('member-1');
    const state = await call(handler, profileId, '127.0.0.1');
    expect(state.sent).toBe(204);
    expect(calls).toEqual([profileId]);
  });

  it('refuses non-loopback callers and missing capabilities without touching keys', async () => {
    // risk: key lifecycle + access control — only the local Desktop may drop keys, and only with its capability.
    const calls: string[] = [];
    const handler = captureRoute({ invalidateProfile: id => calls.push(id) });
    const profileId = ProfileIdentity.fromCloudUserId('member-1');
    expect((await call(handler, profileId, '10.0.0.5')).status).toBe(403);
    expect((await call(handler, profileId, '127.0.0.1', false)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects malformed profile ids', async () => {
    // risk: key lifecycle — arbitrary strings must never select a cache partition.
    const calls: string[] = [];
    const handler = captureRoute({ invalidateProfile: id => calls.push(id) });
    expect((await call(handler, 'profile_unscoped', '127.0.0.1')).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
