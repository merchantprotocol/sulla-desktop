// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

// Sulla Server: Use Cases need an active license key. When the key isn't valid the catalog is
// locked; installed use cases keep working. The server enforces this too (403 license_required).
(function () {
  'use strict';

  let cached = null;

  window.SullaServerLicense = {
    async valid(ctx) {
      if (cached === null) {
        try {
          const res = await ctx.api.get('/server/v1/license');
          const license = res?.data ?? res;
          cached = license?.valid !== false && license?.catalogAllowed !== false;
        } catch (_) {
          // Non-admins can't read the license; the catalog routes answer 403 license_required themselves.
          cached = true;
        }
      }
      return cached;
    },

    renderLocked(ctx, title) {
      ctx.view.innerHTML = '<div class="content uc" style="max-width:none">'
        + `<div class="toolbar"><h1>${ctx.shell.esc(title)}</h1>`
        + '<span class="meta">Ready-made jobs for your agents.</span></div>'
        + '<div class="card" data-uc-locked></div></div>';
      ctx.states.empty(ctx.view.querySelector('[data-uc-locked]'), {
        icon: 'lock',
        title: 'Use Cases need an active license',
        body: 'This server’s license key isn’t valid right now, so it can’t browse, install or update use cases. '
          + 'Use cases that are already installed keep working.',
        actions: [
          { label: 'Check license', primary: true, href: 'server-admin.html#st=license' },
          { label: 'My Library', href: 'use-cases.html#uc=library' },
        ],
      });
    },
  };
})();
