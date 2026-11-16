// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The fixed list of Sulla Cloud paths and methods Desktop may call with the owner's Cloud
 * session (moved verbatim from localAuthority.ts, E9). Static methods never use `this`, so
 * they may be passed around unbound (localAuthorityTestHooks).
 */
export class SullaCloudDesktopRoutePolicy {
  static readonly RULES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
    [/^\/devices\/(?:register|heartbeat)$/, ['POST']],
    [/^\/desktop-channel\/tickets$/, ['POST']],
    [/^\/desktop-sync\/[A-Za-z0-9._~-]{1,200}\/(?:vault|conversations)$/, ['PUT', 'DELETE']],
    [/^\/cloud-runtime\/v1\/device\/(?:workflows|agents|skills|custom-agents|recipes|usage|memory|model-catalog)$/, ['PUT', 'DELETE']],
    [/^\/cloud-runtime\/v1\/device\/use-cases$/, ['DELETE']],
    [/^\/cloud-runtime\/v1\/device$/, ['DELETE']],
    [/^\/cloud-chat-links$/, ['GET', 'POST']],
    [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}$/, ['DELETE']],
    [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/deltas$/, ['POST']],
    [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/attachments\/[A-Za-z0-9._:~-]{1,200}$/, ['GET']],
    [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/cloud-results$/, ['GET']],
    [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/cloud-results\/[A-Za-z0-9_-]{1,200}\/ack$/, ['POST']],
    [/^\/cloud-chat-links\/[A-Za-z0-9_-]{1,200}\/replies\/[A-Za-z0-9_-]{1,200}\/(?:fail|complete)$/, ['POST']],
    [/^\/cloud-usecase-installs\/v1\/device-installs\/pending$/, ['GET']],
    [/^\/cloud-usecase-installs\/v1\/device-installs\/[0-9a-f-]{36}\/report$/, ['POST']],
    [/^\/cloud-vault-sync\/status$/, ['GET']],
    [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}$/, ['PUT', 'DELETE']],
    [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/bundle$/, ['GET']],
    [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/records$/, ['GET']],
    [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/(?:commit|pause|resume)$/, ['POST']],
    [/^\/cloud-vault-sync\/enrollment\/state$/, ['GET']],
    [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/enrollment\/requests$/, ['GET', 'POST']],
    [/^\/cloud-vault-sync\/vaults\/[0-9a-f-]{36}\/enrollment\/requests\/[0-9a-f-]{36}\/(?:respond|consume|confirm)$/, ['POST']],
    [/^\/auth\/password\/device-approval\/requests$/, ['GET']],
    [/^\/auth\/password\/device-approval\/requests\/[0-9a-f-]{36}\/respond$/, ['POST']],
    [/^\/files-sync\/v1\/collections$/, ['GET']],
    [/^\/files-sync\/v1\/usage$/, ['GET']],
    [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}$/, ['PUT', 'DELETE']],
    [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/(?:changes|keys)$/, ['GET']],
    [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/keys\/[1-9][0-9]*$/, ['PUT']],
    [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/chunks\/[0-9a-f]{64}$/, ['GET']],
    [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/uploads$/, ['POST']],
    [/^\/files-sync\/v1\/collections\/[0-9a-f-]{36}\/commit$/, ['POST']],
    [/^\/files-sync\/v1\/uploads\/[0-9a-f-]{36}$/, ['GET']],
    [/^\/files-sync\/v1\/uploads\/[0-9a-f-]{36}\/chunks\/[0-9a-f]{64}$/, ['PUT']],
    // Support Center (user side): tickets, feedback, uploads, consent, timeline.
    // Remote support (supporter side): Workers enforces super-admin + accepted-by-caller on each route.
    [/^\/super-admin\/support\/sessions$/, ['GET']],
    [/^\/super-admin\/support\/sessions\/[A-Za-z0-9_-]{1,200}\/(?:events|presence)$/, ['GET']],
    [/^\/super-admin\/support\/sessions\/[A-Za-z0-9_-]{1,200}\/(?:rpc|end|extend)$/, ['POST']],
    // Files catalog and just-in-time content stay scoped to the registered Desktop.
    [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}$/, ['PUT']],
    [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests$/, ['GET']],
    [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests\/[A-Za-z0-9._~-]{1,200}\/content$/, ['PUT']],
    [/^\/cloud-files\/v1\/catalog\/[A-Za-z0-9._~-]{1,200}\/desktop-requests\/[A-Za-z0-9._~-]{1,200}\/(?:link|fail)$/, ['POST']],
    [/^\/shares$/, ['POST']],
    [/^\/shares\/[A-Za-z0-9._~-]{1,200}$/, ['PATCH', 'DELETE']],
    [/^\/shares\/[A-Za-z0-9._~-]{1,200}\/content$/, ['PUT']],
    [/^\/sync\/(?:push|pull)$/, ['GET', 'POST']],
    [/^\/marketplace\/(?:browse|topics|mine)$/, ['GET']],
    [/^\/marketplace\/submit-manifest$/, ['POST']],
    [/^\/marketplace\/templates\/[A-Za-z0-9._~-]{1,200}$/, ['GET', 'DELETE']],
    [/^\/marketplace\/templates\/[A-Za-z0-9._~-]{1,200}\/bundle$/, ['PUT']],
  ];

  static allowsByoUsageCloudRequest(method: string, path: string): boolean {
    return method === 'POST' && path === '/usage/byo-events';
  }

  static allowsSullaCloudDesktopRequest(method: string, path: string): boolean {
    return SullaCloudDesktopRoutePolicy.allowsByoUsageCloudRequest(method, path) ||
      SullaCloudDesktopRoutePolicy.RULES.some(([pattern, methods]) => pattern.test(path) && methods.includes(method));
  }
}
