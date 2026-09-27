/**
 * Publish a local artifact folder to the marketplace: build the sulla/v3
 * manifest, zip the publishable files, then the two-step submit
 * (POST /submit-manifest → PUT /templates/:id/bundle). The listing lands as
 * `pending` until an admin approves it.
 *
 * Shared by the Library's `bundles-publish` IPC and the agent's
 * `marketplace/publish` tool.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as yazl from 'yazl';

import { listBundleFiles } from './bundleFiles';
import { submitManifest, uploadBundle, type MarketplaceKind } from './client';
import { buildManifest } from './manifestBuilder';

import { resolveSullaHomeDir } from '@pkg/agent/utils/sullaPaths';

export interface PublishOverrides {
  name?:        string;
  description?: string;
  version?:     string;
  tags?:        string[];
}

export interface PublishResult {
  templateId:    string;
  slug:          string;
  bundle_status: 'uploaded';
  bundle_size:   number;
  status:        'pending';
}

/** Where a local artifact of this kind lives, keyed by folder name. */
export function localArtifactDir(kind: MarketplaceKind, folder: string): string {
  return path.join(resolveSullaHomeDir(), `${ kind }s`, folder);
}

export function zipDirectory(sourceDir: string, slug: string, zipPath: string): Promise<void> {
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();

    for (const absFile of listBundleFiles(sourceDir)) {
      const relPath = path.relative(sourceDir, absFile).split(path.sep).join('/');
      zip.addFile(absFile, `${ slug }/${ relPath }`);
    }
    zip.end();

    const out = fs.createWriteStream(zipPath);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.on('error', reject).pipe(out);
  });
}

export async function publishLocalArtifact(args: {
  kind:       MarketplaceKind;
  sourceDir:  string;
  slug:       string;
  overrides?: PublishOverrides;
}): Promise<PublishResult> {
  const { kind, sourceDir, slug, overrides } = args;

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`bundle source does not exist: ${ sourceDir }`);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = buildManifest(kind, { slug, bundleRoot: sourceDir, overrides });
  } catch (err) {
    throw new Error(`manifest build failed: ${ err instanceof Error ? err.message : String(err) }`);
  }

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-publish-'));
  const zipPath = path.join(tmpdir, `${ slug }.zip`);

  try {
    await zipDirectory(sourceDir, slug, zipPath);

    const meta = (manifest.metadata ?? {}) as Record<string, unknown>;
    const submit = await submitManifest({
      kind,
      name:        String(meta.name ?? slug),
      description: String(meta.description ?? ''),
      version:     String(meta.version ?? '1.0.0'),
      tags:        Array.isArray(meta.tags) ? meta.tags as string[] : [],
      manifest,
    });
    const upload = await uploadBundle(submit.id, zipPath);

    return {
      templateId:    submit.id,
      slug:          submit.slug,
      bundle_status: upload.bundle_status,
      bundle_size:   upload.bundle_size,
      status:        upload.status,
    };
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}
