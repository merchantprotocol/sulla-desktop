// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// File and HTTP helpers for the release scripts (Node 22 built-ins only).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError, withRetry } from './lib.mjs';

/**
 * Hash a local file in one pass.
 * @returns {Promise<{ size: number, sha512: string, sha256: string }>} sha512 base64, sha256 hex
 */
export async function hashFile(filePath) {
  const sha512 = crypto.createHash('sha512');
  const sha256 = crypto.createHash('sha256');
  let size = 0;

  await pipeline(fs.createReadStream(filePath), async function(source) {
    for await (const chunk of source) {
      sha512.update(chunk);
      sha256.update(chunk);
      size += chunk.length;
    }
  });

  return { size, sha512: sha512.digest('base64'), sha256: sha256.digest('hex') };
}

/** Hash a remote file (streamed, never stored). Returns null on 404. */
export async function hashUrl(url, { fetchImpl = fetch, retry = {} } = {}) {
  return withRetry(async() => {
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(60 * 60 * 1000) });

    if (res.status === 404) {
      await res.body?.cancel();

      return null;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new HttpError(res.status, `GET ${ url } returned ${ res.status }`);
    }
    const sha512 = crypto.createHash('sha512');
    let size = 0;

    for await (const chunk of Readable.fromWeb(res.body)) {
      sha512.update(chunk);
      size += chunk.length;
    }

    return { size, sha512: sha512.digest('base64') };
  }, retry);
}

/** HEAD a public URL. Returns { status, size } with size from Content-Length (or null). */
export async function headUrl(url, { fetchImpl = fetch, retry = {} } = {}) {
  return withRetry(async() => {
    const res = await fetchImpl(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(60 * 1000) });

    if (res.status >= 500 || res.status === 429) {
      throw new HttpError(res.status, `HEAD ${ url } returned ${ res.status }`);
    }
    const length = res.headers.get('content-length');

    return { status: res.status, size: length === null ? null : Number(length) };
  }, retry);
}

/** GET a small text file. Returns null on 404. */
export async function getText(url, { fetchImpl = fetch, retry = {} } = {}) {
  return withRetry(async() => {
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(60 * 1000) });

    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new HttpError(res.status, `GET ${ url } returned ${ res.status }`);
    }

    return res.text();
  }, retry);
}
