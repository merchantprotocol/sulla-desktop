// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { OrgCollectionRoutes } from '../src/routes/OrgCollectionRoutes.js';

type Handler = (request: unknown, response: unknown) => Promise<void>;

function registerRoutes(profileCaches?: { invalidateCurrent(): void }) {
  const posts = new Map<string, Handler>();
  new OrgCollectionRoutes({ mode: 'desktop' }, {} as never, undefined, profileCaches)
    .register({ post: (path: string, handler: Handler) => posts.set(path, handler), put() {}, patch() {}, get() {}, delete() {} } as never);
  return posts;
}

function call(handler: Handler, remoteAddress: string, capability = true) {
  const state = { status: 0, body: undefined as unknown, sent: undefined as number | undefined };
  const response = {
    setHeader() {}, status(code: number) { state.status = code; return this }, json(body: unknown) { state.body = body; return this },
    sendStatus(code: number) { state.sent = code; return this },
  };
  const request = { params: {}, socket: { remoteAddress }, filesIdentity: capability ? { kind: 'capability' } : undefined };
  return handler(request, response).then(() => state);
}

describe('invalidate-current route', () => {
  it('is the only invalidation route and carries no profile id in its path', () => {
    // risk: tenant isolation — Desktop must not name a partition; Files picks the principal it serves.
    const paths = [...registerRoutes({ invalidateCurrent() {} }).keys()];
    expect(paths).toContain('/v1/desktop/org-profiles/invalidate-current');
    expect(paths.some(path => path.includes('org-profiles/:profileId'))).toBe(false);
  });

  it('drops the served principal from loopback with a desktop capability', async () => {
    // risk: key lifecycle — sign-out must reach Files and erase the signed-in principal's org roots.
    let calls = 0;
    const handler = registerRoutes({ invalidateCurrent() { calls++ } }).get('/v1/desktop/org-profiles/invalidate-current')!;
    const state = await call(handler, '127.0.0.1');
    expect(state.sent).toBe(204);
    expect(calls).toBe(1);
  });

  it('refuses non-loopback callers and missing capabilities without touching keys', async () => {
    // risk: key lifecycle + access control — only the local Desktop may drop keys, and only with its capability.
    let calls = 0;
    const handler = registerRoutes({ invalidateCurrent() { calls++ } }).get('/v1/desktop/org-profiles/invalidate-current')!;
    expect((await call(handler, '10.0.0.5')).status).toBe(403);
    expect((await call(handler, '127.0.0.1', false)).status).toBe(403);
    expect(calls).toBe(0);
  });

  it('answers 503 when profile caches are not configured', async () => {
    // risk: key lifecycle — an unwired Files must fail loudly rather than report a silent sign-out.
    const handler = registerRoutes(undefined).get('/v1/desktop/org-profiles/invalidate-current')!;
    expect((await call(handler, '127.0.0.1')).status).toBe(503);
  });
});
