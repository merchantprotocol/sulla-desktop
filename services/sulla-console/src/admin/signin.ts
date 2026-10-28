// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Router } from 'express';

import { adminRoute, adminWrite, record } from './common.js';
import type { RouteContext } from '../routes/helpers.js';

function publicSmtp(value: unknown): Record<string, unknown> {
  const smtp = record(value);
  return {
    host: smtp.host ?? '',
    port: Number(smtp.port ?? 587),
    username: smtp.user ?? smtp.username ?? '',
    from: smtp.from ?? smtp.fromDisplayName ?? '',
  };
}

export function registerSigninRoutes(router: Router, context: RouteContext): void {
  router.get('/server/v1/signin', adminRoute(async(_request, response) => {
    const settings = record(await context.clients.accounts.admin('/signin'));
    response.json({
      methods: { password: true, emailCode: false, sso: false },
      requireTwoStep: settings.otpRequired === true,
      invitationDays: 7,
      smtp: publicSmtp(settings.smtp),
      registrationAllowed: false,
    });
  }));

  router.put('/server/v1/signin', adminWrite(context, 'admin.signin.update', async(request, response) => {
    const input = record(request.body);
    const update: Record<string, unknown> = {};
    if (typeof input.requireTwoStep === 'boolean') update.otpRequired = input.requireTwoStep;
    if (input.smtp && typeof input.smtp === 'object') update.smtp = input.smtp;
    if (!Object.keys(update).length) {
      response.status(503).json({ error: 'setting_unavailable', available: false });
      return;
    }
    await context.clients.accounts.admin('/signin', { method: 'PUT', body: JSON.stringify(update) });
    response.json({ ok: true });
  }));

  router.post('/server/v1/signin/test-email', adminWrite(context, 'admin.signin.test_email', async(request, response) => {
    await context.clients.accounts.admin('/signin/test-email', {
      method: 'POST',
      body: JSON.stringify(record(request.body)),
    });
    response.json({ ok: true });
  }));
}
