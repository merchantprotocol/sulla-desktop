// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import type { Router } from 'express';

import { adminRoute, record, text } from './common.js';
import { containers, serviceName } from './docker.js';
import type { RouteContext } from '../routes/helpers.js';

interface ImageParts { registry: string; repository: string; tag: string }

function imageParts(image: string): ImageParts | null {
  const match = image.match(/^(?:(?<registry>[^/]+\.[^/]+)\/)?(?<repository>[^:@]+(?:\/[^:@]+)*):(?<tag>[^:@]+)$/);
  if (!match?.groups) return null;
  return {
    registry: match.groups.registry ?? 'docker.io',
    repository: match.groups.repository,
    tag: match.groups.tag,
  };
}

async function ghcrTags(repository: string): Promise<string[]> {
  const path = `/v2/${repository}/tags/list?n=100`;
  let response = await fetch(`https://ghcr.io${path}`, { signal: AbortSignal.timeout(5_000) });
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') ?? '';
    const realm = challenge.match(/realm="([^"]+)"/)?.[1];
    const service = challenge.match(/service="([^"]+)"/)?.[1];
    const scope = challenge.match(/scope="([^"]+)"/)?.[1];
    if (!realm || !service || !scope) return [];
    const tokenUrl = new URL(realm);
    tokenUrl.search = new URLSearchParams({ service, scope }).toString();
    const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(5_000) });
    const token = text(record(await tokenResponse.json()).token);
    if (!token) return [];
    response = await fetch(`https://ghcr.io${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
  }
  if (!response.ok) return [];
  const tags = record(await response.json()).tags;
  return Array.isArray(tags) ? tags.map(value => text(value)).filter(Boolean) : [];
}

function semver(tags: string[]): string | null {
  return tags
    .filter(tag => /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }))[0]
    ?? null;
}

export function registerUpdatesRoutes(router: Router, _context: RouteContext): void {
  router.get('/server/v1/updates', adminRoute(async(_request, response) => {
    let installed = 'unknown';
    let installedAt: string | null = null;
    let latest: string | null = null;
    let available = false;
    try {
      const all = await containers();
      const consoleContainer = all.find(container => serviceName(container) === 'console');
      const image = imageParts(String(consoleContainer?.Image ?? ''));
      installed = image?.tag ?? process.env.SULLA_IMAGE_TAG ?? 'unknown';
      installedAt = consoleContainer?.Created ? new Date(consoleContainer.Created * 1_000).toISOString() : null;
      if (image?.registry === 'ghcr.io') {
        latest = semver(await ghcrTags(image.repository));
        available = latest !== null;
      }
    } catch {
      // The honest unavailable shape below is rendered as no available update.
    }
    response.json({
      version: installed,
      installedAt,
      latest: latest ? { version: latest } : null,
      available,
      history: [],
      updateCommand: null,
      reason: available ? undefined : 'The image registry did not report a latest release.',
    });
  }));
}
