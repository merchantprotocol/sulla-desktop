/**
 * Sulla Marketplace HTTP client.
 *
 * Thin wrappers over the sulla-workers marketplace endpoints. Auth is
 * resolved via `getCurrentAccessToken()` (auto-refresh included), so
 * callers never hand tokens around manually.
 *
 * Endpoints covered:
 *
 *   GET    /marketplace/templates/:id          fetchTemplateDetail
 *   GET    /marketplace/templates/:id/download downloadBundleToFile
 *   POST   /marketplace/submit-manifest        submitManifest
 *   PUT    /marketplace/templates/:id/bundle   uploadBundle
 *   GET    /marketplace/mine                   listMySubmissions
 *   DELETE /marketplace/templates/:id          takedownTemplate
 *
 * Admin routes are out of scope here (those live on sulla-admin with
 * a static Bearer key).
 *
 * Every call that hits an authenticated endpoint will:
 *  1. Pull the current access token from sullaCloudAuth.
 *  2. On 401, force a refresh and retry once.
 *  3. Throw a descriptive error if still failing — callers log + surface.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';

import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

/**
 * Base URL for the marketplace API. Must match the one used by
 * `sullaCloudAuth.ts` so the JWT is valid for this host.
 */
const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';

// ─── Types mirroring the marketplace response shapes ────────────────
// Kept minimal — we only type what our callers consume. The marketplace
// agent is authoritative for the full schemas (see docs/marketplace/).

export type MarketplaceKind = 'routine' | 'skill' | 'function' | 'recipe';

export interface MarketplaceTemplateDetail {
  id:                   string;
  kind:                 MarketplaceKind;
  slug:                 string;
  name:                 string;
  description?:         string | null;
  version:              string;
  author_contractor_id: string;
  tags?:                string[];
  status:               'pending' | 'approved' | 'rejected';
  bundle_status:        'pending' | 'uploaded' | 'missing';
  bundle_size?:         number;
  download_count?:      number;
  created_at:           string;
  updated_at:           string;
  manifest:             Record<string, unknown>;
}

export interface SubmitManifestResult {
  id:                string;
  slug:              string;
  bundle_status:     'pending';
  bundle_upload_url: string;
}

export interface UploadBundleResult {
  id:            string;
  bundle_status: 'uploaded';
  bundle_size:   number;
  status:        'pending';
}

/** A row returned by GET /marketplace/mine. Superset of the public fields —
 *  /mine also surfaces admin_notes and reviewed_at because the author has
 *  legitimate reason to see review feedback on their own submissions. */
export interface MySubmissionRow {
  id:                   string;
  kind:                 MarketplaceKind;
  slug:                 string;
  name:                 string;
  description?:         string | null;
  version:              string;
  author_contractor_id: string;
  tags:                 string[];
  status:               'pending' | 'approved' | 'rejected';
  bundle_status:        'pending' | 'uploaded' | 'missing';
  bundle_size?:         number | null;
  download_count?:      number;
  featured?:            boolean;
  tagline?:             string | null;
  category?:            string | null;
  admin_notes?:         string | null;
  reviewed_at?:         string | null;
  created_at:           string;
  updated_at:           string;
}

export interface MySubmissionsPage {
  templates: MySubmissionRow[];
  total:     number;
  page:      number;
  limit:     number;
}

/** Server distinguishes the two outcomes so the UI can message correctly
 *  ("Withdrawn — kept for your records" vs "Deleted"). */
export interface TakedownResult {
  success: true;
  action:  'deleted' | 'withdrawn';
}

// ─── Helpers ────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getCurrentAccessToken();
  if (!token) {
    throw new Error('Not signed in to Sulla Cloud — cannot call marketplace API');
  }

  return { Authorization: `Bearer ${ token }` };
}

/**
 * One retry on 401 — the token may have expired between `authHeaders()`
 * and the actual request. `getCurrentAccessToken` already refreshes
 * when <60s to expiry, but refresh failures, clock skew, and revocation
 * still surface as 401; retrying once covers the common case cleanly.
 */
async function fetchWithAuthRetry(
  url:  string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = { ...(init.headers ?? {}), ...(await authHeaders()) };
  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    // Force a refresh by reading the token again (getCurrentAccessToken
    // refreshes lazily when expired). Then retry once.
    const retryHeaders = { ...(init.headers ?? {}), ...(await authHeaders()) };
    res = await fetch(url, { ...init, headers: retryHeaders });
  }

  return res;
}

async function readJsonOrThrow<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let errorMsg = `${ res.status } ${ res.statusText }`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body?.error) errorMsg = body.error;
    } catch { /* non-JSON body; fall back to status */ }
    throw new Error(`[${ context }] ${ errorMsg }`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`[${ context }] response was not valid JSON`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Fetch the full detail for an approved marketplace template, including
 * the inlined sulla/v3 manifest. Used by the install flow to decide
 * which kind-specific landing handler to invoke without having to crack
 * the zip first.
 */
export async function fetchTemplateDetail(
  templateId: string,
): Promise<MarketplaceTemplateDetail> {
  const url = `${ API_BASE }/marketplace/templates/${ encodeURIComponent(templateId) }`;
  const res = await fetchWithAuthRetry(url, { method: 'GET' });
  const body = await readJsonOrThrow<{ template: MarketplaceTemplateDetail }>(
    res,
    'fetchTemplateDetail',
  );

  return body.template;
}

/**
 * Download a bundle zip to `destFile`. Streams the response body to
 * disk so we don't buffer 25 MB in memory. Creates the parent dir if
 * it doesn't exist. Returns the byte count written.
 */
export async function downloadBundleToFile(
  templateId: string,
  destFile:   string,
): Promise<number> {
  const url = `${ API_BASE }/marketplace/templates/${ encodeURIComponent(templateId) }/download`;
  const res = await fetchWithAuthRetry(url, { method: 'GET' });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[downloadBundleToFile] ${ res.status } ${ res.statusText } — ${ errText.slice(0, 200) }`);
  }
  if (!res.body) {
    throw new Error('[downloadBundleToFile] empty response body');
  }

  await fs.promises.mkdir(path.dirname(destFile), { recursive: true });

  // Convert WHATWG ReadableStream → Node stream via Node's built-in conversion.
  // Node 18+ has `Readable.fromWeb` but `pipeline` accepts the web stream
  // directly in recent Node/Electron combos; fall back via dynamic import if
  // needed.
  const out = fs.createWriteStream(destFile);

  const { Readable } = require('stream');
  const nodeStream = Readable.fromWeb(res.body as any);
  await pipeline(nodeStream, out);

  const stats = await fs.promises.stat(destFile);

  console.log(`[marketplace] downloaded bundle tpl=${ templateId } → ${ destFile } (${ stats.size } bytes)`);

  return stats.size;
}

/**
 * POST /submit-manifest. Lands a pending row in D1. Caller must
 * immediately follow up with `uploadBundle(id, zipPath)` to enter the
 * review queue.
 */
export async function submitManifest(payload: {
  kind:         MarketplaceKind;
  name:         string;
  description?: string;
  version?:     string;
  tags?:        string[];
  manifest:     Record<string, unknown>;
}): Promise<SubmitManifestResult> {
  const url = `${ API_BASE }/marketplace/submit-manifest`;
  const res = await fetchWithAuthRetry(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const body = await readJsonOrThrow<{ template: SubmitManifestResult }>(
    res,
    'submitManifest',
  );

  console.log(`[marketplace] submitted manifest kind=${ payload.kind } name="${ payload.name }" → ${ body.template.id }`);

  return body.template;
}

/**
 * PUT /templates/:id/bundle. Streams the zip from disk. On success the
 * row flips bundle_status='uploaded' and enters the admin review queue.
 */
export async function uploadBundle(
  templateId: string,
  zipPath:    string,
): Promise<UploadBundleResult> {
  const stats = await fs.promises.stat(zipPath);
  if (!stats.isFile()) {
    throw new Error(`[uploadBundle] ${ zipPath } is not a file`);
  }

  const url = `${ API_BASE }/marketplace/templates/${ encodeURIComponent(templateId) }/bundle`;

  // node-fetch / undici accept a web ReadableStream in body; building one
  // from a node stream keeps memory bounded for the 25 MB cap.
  const nodeStream = fs.createReadStream(zipPath);

  const { Readable } = require('stream');
  const webStream = Readable.toWeb(nodeStream);

  const res = await fetchWithAuthRetry(url, {
    method:  'PUT',
    headers: {
      'Content-Type':   'application/zip',
      'Content-Length': String(stats.size),
    },
    body:     webStream,
    // undici requires duplex:'half' for streaming request bodies.
    duplex:   'half',
  } as any);

  const body = await readJsonOrThrow<{ template: UploadBundleResult }>(
    res,
    'uploadBundle',
  );

  console.log(`[marketplace] uploaded bundle tpl=${ templateId } → bundle_status=${ body.template.bundle_status } size=${ body.template.bundle_size }`);

  return body.template;
}

/**
 * GET /marketplace/mine. Returns every submission authored by the signed-in
 * user — pending / approved / rejected — so the desktop can render a
 * "My Submissions" view without a second request per row.
 *
 * Pagination mirrors the server: 1-indexed pages, server clamps limit to
 * [1, 100] regardless of what we ask for.
 */
export async function listMySubmissions(
  page = 1,
  limit = 50,
): Promise<MySubmissionsPage> {
  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  const url = `${ API_BASE }/marketplace/mine?${ qs.toString() }`;
  const res = await fetchWithAuthRetry(url, { method: 'GET' });

  return readJsonOrThrow<MySubmissionsPage>(res, 'listMySubmissions');
}

/**
 * DELETE /marketplace/templates/:id. User-initiated takedown of their own
 * submission. Server enforces author == caller; callers only need the id.
 *
 * Result shape tells the UI whether the row was hard-deleted (pending /
 * rejected submissions — never publicly visible after this) or soft
 * withdrawn (approved submissions — row stays so the author can see
 * "I withdrew this" in /mine, but the bundle is gone and the browse
 * feed won't serve it).
 */
export async function takedownTemplate(
  templateId: string,
): Promise<TakedownResult> {
  const url = `${ API_BASE }/marketplace/templates/${ encodeURIComponent(templateId) }`;
  const res = await fetchWithAuthRetry(url, { method: 'DELETE' });
  const body = await readJsonOrThrow<TakedownResult>(res, 'takedownTemplate');

  console.log(`[marketplace] takedown tpl=${ templateId } → ${ body.action }`);

  return body;
}
