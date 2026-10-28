// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Release uploader: lets CI publish files to the releases R2 bucket with one
// bearer token, without Cloudflare API credentials. Large files go up in parts
// (a Worker request body is limited to about 100 MB), using R2 multipart uploads.
//
//   POST /v1/upload/create?key=K[&contentType=T][&cacheControl=C]   -> { uploadId }
//   PUT  /v1/upload/part?key=K&uploadId=U&partNumber=N               -> { partNumber, etag }
//   POST /v1/upload/complete?key=K&uploadId=U   { parts: [...] }     -> { key, size, etag }
//   POST /v1/upload/abort?key=K&uploadId=U                           -> { ok: true }
//   PUT  /v1/object?key=K[&contentType=T][&cacheControl=C]           -> { key, size }   (small files)
//
// Every route needs `Authorization: Bearer <UPLOAD_TOKEN>`. Keys must live under
// releases/ or channels/. Nothing here can read, list or delete objects.

const MAX_BODY = 95 * 1024 * 1024;
const KEY_PATTERN = /^(releases|channels)\/[A-Za-z0-9._/-]{1,480}$/;
const CACHE_CONTROL = new Set([
  'no-cache',
  'no-store',
  'public, max-age=300',
  'public, max-age=31536000, immutable',
]);
const CONTENT_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function fail(status, error) {
  return json({ error }, status);
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function authorized(request, env) {
  const match = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '');

  if (!match || !env.UPLOAD_TOKEN) {
    return false;
  }
  const [given, expected] = await Promise.all([sha256(match[1]), sha256(env.UPLOAD_TOKEN)]);
  let diff = 0;

  for (let i = 0; i < given.length; i++) {
    diff |= given[i] ^ expected[i];
  }

  return diff === 0;
}

function validKey(key) {
  return Boolean(key) && KEY_PATTERN.test(key) && !key.includes('..') && !key.includes('//') && !key.endsWith('/');
}

function metadata(url) {
  const contentType = url.searchParams.get('contentType');
  const cacheControl = url.searchParams.get('cacheControl');
  const httpMetadata = {};

  if (contentType) {
    if (!CONTENT_TYPE_PATTERN.test(contentType)) {
      return { error: 'invalid contentType' };
    }
    httpMetadata.contentType = contentType;
  }
  if (cacheControl) {
    if (!CACHE_CONTROL.has(cacheControl)) {
      return { error: 'invalid cacheControl' };
    }
    httpMetadata.cacheControl = cacheControl;
  }

  return { httpMetadata };
}

function bodyLength(request) {
  const length = Number(request.headers.get('content-length'));

  return Number.isInteger(length) && length >= 0 ? length : null;
}

export default {
  async fetch(request, env) {
    if (!await authorized(request, env)) {
      return fail(401, 'unauthorized');
    }

    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (!validKey(key)) {
      return fail(400, 'invalid key');
    }

    const route = `${ request.method } ${ url.pathname }`;
    const uploadId = url.searchParams.get('uploadId') ?? '';

    try {
      switch (route) {
      case 'POST /v1/upload/create': {
        const meta = metadata(url);

        if (meta.error) {
          return fail(400, meta.error);
        }
        const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: meta.httpMetadata });

        return json({ uploadId: upload.uploadId });
      }

      case 'PUT /v1/upload/part': {
        const partNumber = Number(url.searchParams.get('partNumber'));
        const length = bodyLength(request);

        if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
          return fail(400, 'invalid uploadId or partNumber');
        }
        if (length === null || length === 0 || length > MAX_BODY || !request.body) {
          return fail(413, `part must be 1 byte to ${ MAX_BODY } bytes with a Content-Length`);
        }
        const part = await env.BUCKET.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, request.body);

        return json({ partNumber: part.partNumber, etag: part.etag });
      }

      case 'POST /v1/upload/complete': {
        const body = await request.json().catch(() => null);
        const parts = body?.parts;

        if (!uploadId || !Array.isArray(parts) || parts.length === 0 || parts.length > 10000 ||
            !parts.every(p => Number.isInteger(p?.partNumber) && typeof p?.etag === 'string')) {
          return fail(400, 'invalid parts');
        }
        const object = await env.BUCKET.resumeMultipartUpload(key, uploadId).complete(
          parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })),
        );

        return json({ key, size: object.size, etag: object.etag });
      }

      case 'POST /v1/upload/abort': {
        if (!uploadId) {
          return fail(400, 'invalid uploadId');
        }
        await env.BUCKET.resumeMultipartUpload(key, uploadId).abort();

        return json({ ok: true });
      }

      case 'PUT /v1/object': {
        const meta = metadata(url);
        const length = bodyLength(request);

        if (meta.error) {
          return fail(400, meta.error);
        }
        if (length === null || length > MAX_BODY || !request.body) {
          return fail(413, `object must be at most ${ MAX_BODY } bytes with a Content-Length; use multipart for larger files`);
        }
        const object = await env.BUCKET.put(key, request.body, { httpMetadata: meta.httpMetadata });

        return json({ key, size: object.size });
      }

      default:
        return fail(404, 'not found');
      }
    } catch (error) {
      console.error('release-uploader error', route, error instanceof Error ? error.message : String(error));

      return fail(502, 'storage error');
    }
  },
};
