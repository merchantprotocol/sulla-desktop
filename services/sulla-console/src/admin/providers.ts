// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import type { Router } from 'express';
import sodium from 'libsodium-wrappers-sumo';

import { activeOrganization, adminRoute, adminWrite, array, record, text } from './common.js';
import type { RouteContext } from '../routes/helpers.js';
import { audit, param, serviceJson } from '../routes/helpers.js';

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models', kind: 'api' },
  { id: 'openai', name: 'OpenAI', description: 'GPT and reasoning models', kind: 'api' },
  { id: 'google', name: 'Google', description: 'Gemini models', kind: 'api' },
  { id: 'ollama', name: 'Local models', description: 'Ollama on your network', kind: 'local' },
];

const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
];

async function latestDetails(context: RouteContext, kind: string): Promise<Record<string, unknown>[]> {
  const result = await context.db.query<{ details: Record<string, unknown> }>(
    `SELECT DISTINCT ON (details->>'provider') details
       FROM sulla_console.audit_events
      WHERE kind=$1
      ORDER BY details->>'provider',created_at DESC`,
    [kind],
  );
  return result.rows.map(row => row.details);
}

async function defaults(context: RouteContext): Promise<Record<string, unknown>> {
  const result = await context.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM sulla_console.audit_events
      WHERE kind='admin.providers.defaults' ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows[0]?.details ?? { model: 'claude-sonnet-5-5', fallback: null };
}

async function seal(apiKey: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const recipient = sodium.from_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const ciphertext = sodium.crypto_box_seal(sodium.from_string(apiKey), recipient);
  return sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function registerProvidersRoutes(router: Router, context: RouteContext): void {
  router.get('/server/v1/providers', adminRoute(async(request, response) => {
    const organizationId = await activeOrganization(context, request);
    const [vault, savedHints, savedDefaults] = await Promise.all([
      serviceJson<{ providers?: unknown }>(request, context.clients, 'vault', organizationId, '/v1/server-providers'),
      latestDetails(context, 'admin.provider.saved'),
      defaults(context),
    ]);
    const connected = new Map(array(vault.providers).map(item => [text(item.provider), item]));
    const hints = new Map(savedHints.map(item => [text(item.provider), item]));
    response.json({
      providers: PROVIDERS.map(provider => {
        const stored = connected.get(provider.id);
        const hint = hints.get(provider.id);
        return {
          ...provider,
          connected: provider.kind === 'local' ? Boolean(hint?.baseUrl) : stored?.usable === true,
          keyHint: hint?.suffix ? `•••• ${text(hint.suffix)}` : '',
          baseUrl: provider.kind === 'local' ? text(hint?.baseUrl) : undefined,
        };
      }),
      models: MODELS,
      defaults: savedDefaults,
    });
  }));

  router.put('/server/v1/providers/defaults', adminWrite(context, 'admin.providers.defaults', async(request, response) => {
    response.json({ ok: true, defaults: request.body });
  }));

  router.put('/server/v1/providers/:id', adminWrite(context, 'admin.provider.update', async(request, response) => {
    const organizationId = await activeOrganization(context, request);
    const provider = param(request, 'id');
    const body = record(request.body);
    if (provider === 'ollama') {
      const baseUrl = text(body.baseUrl);
      if (!baseUrl) throw Object.assign(new Error('base_url_required'), { status: 400 });
      await audit(context.db, request, organizationId, 'admin.provider.saved', { provider, baseUrl });
      response.json({ ok: true, provider });
      return;
    }
    const apiKey = text(body.apiKey);
    if (!apiKey) throw Object.assign(new Error('api_key_required'), { status: 400 });
    const recipient = await serviceJson<{ publicKey: string; fingerprint: string }>(
      request,
      context.clients,
      'vault',
      organizationId,
      '/v1/server-providers/recipient',
    );
    const ciphertext = await seal(apiKey, recipient.publicKey);
    await serviceJson(
      request,
      context.clients,
      'vault',
      organizationId,
      `/v1/server-providers/${encodeURIComponent(provider)}`,
      'PUT',
      {
        sealedCredential: { version: 1, algorithm: 'x25519-sealed-box', ciphertext },
        recipientFingerprint: recipient.fingerprint,
      },
    );
    await audit(context.db, request, organizationId, 'admin.provider.saved', {
      provider,
      suffix: apiKey.slice(-4),
    });
    response.json({ ok: true, provider });
  }));
}
