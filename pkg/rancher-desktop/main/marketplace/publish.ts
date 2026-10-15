/**
 * Publish a Postgres artifact to the marketplace: materialize it temporarily,
 * build the manifest, zip the publishable files, then the two-step submit
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

import { checkAgentManifestForPublish } from './agentPublishSafety';
import { listBundleFiles } from './bundleFiles';
import { submitManifest, uploadBundle, type MarketplaceKind } from './client';
import { materializeDatabaseArtifact, packageContent, readDatabaseArtifact } from './databaseArtifacts';
import { buildManifest } from './manifestBuilder';

import type { InstallableKind, PackageManifest } from './databaseInstaller';

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
  status:        'pending' | 'approved';
  warnings?:     string[];
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
  slug:       string;
  overrides?: PublishOverrides;
}): Promise<PublishResult> {
  const { kind, slug, overrides } = args;
  if (kind === 'package') throw new Error('Use publishPackage for package submissions');
  const artifact = await readDatabaseArtifact(kind as InstallableKind, slug);
  const materialized = materializeDatabaseArtifact(artifact);
  let effectiveSourceDir = materialized.dir;
  let stagingDir: string | null = null;
  const warnings: string[] = [];

  if (kind === 'agent') {
    const manifest = artifact.manifest as any;
    const serialized = `${ JSON.stringify(manifest, null, 2) }\n`;
    const check = checkAgentManifestForPublish(manifest);

    if (check.secret) {
      materialized.cleanup();
      throw new Error(`agent.json contains a possible ${ check.secret } secret. Remove credentials from the agent before publishing.`);
    }
    warnings.push(...check.warnings);

    fs.writeFileSync(path.join(effectiveSourceDir, 'agent.json'), serialized, 'utf8');
  }

  if (!fs.existsSync(effectiveSourceDir) || !fs.statSync(effectiveSourceDir).isDirectory()) {
    materialized.cleanup();
    throw new Error(`bundle source does not exist: ${ effectiveSourceDir }`);
  }

  // Workflow manifests are sanitized in-place by the builder. Work from a
  // publish-only copy so exporting can never rewrite the user's source file.
  if (kind === 'routine') {
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-workflow-publish-'));
    const stagedRoot = path.join(stagingDir, slug);
    fs.mkdirSync(stagedRoot, { recursive: true });
    for (const sourceFile of listBundleFiles(effectiveSourceDir)) {
      const relative = path.relative(effectiveSourceDir, sourceFile);
      const destination = path.join(stagedRoot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(sourceFile, destination);
    }
    effectiveSourceDir = stagedRoot;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = buildManifest(kind, { slug, bundleRoot: effectiveSourceDir, overrides, writeSanitized: kind === 'routine' });
  } catch (err) {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    materialized.cleanup();
    throw new Error(`manifest build failed: ${ err instanceof Error ? err.message : String(err) }`);
  }

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-publish-'));
  const zipPath = path.join(tmpdir, `${ slug }.zip`);

  try {
    await zipDirectory(effectiveSourceDir, slug, zipPath);

    const meta = (manifest.metadata ?? {}) as Record<string, unknown>;
    const submit = await submitManifest({
      kind,
      name:        String(meta.name ?? meta.title ?? slug),
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
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    materialized.cleanup();
  }
}

export async function publishPackage(args: {
  slug:        string;
  title:       string;
  description: string;
  topic?:      string;
  version?:    string;
  items:       { kind: InstallableKind; slug: string }[];
}): Promise<PublishResult> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(args.slug)) throw new Error('Package slug must use lowercase letters, numbers, dots, underscores, or dashes');
  if (!args.title.trim()) throw new Error('Package title is required');
  if (!args.items.length) throw new Error('Package contents must include at least one database artifact');

  const seen = new Set<string>();
  const contents: import('./databaseInstaller').PackageContent[] = [];
  let includesWebApp = false;
  for (const item of args.items) {
    const key = `${ item.kind }:${ item.slug }`;
    if (seen.has(key)) continue;
    seen.add(key);
    const artifact = await readDatabaseArtifact(item.kind, item.slug);
    contents.push(packageContent(artifact));
    if (item.kind === 'recipe' && Array.isArray(artifact.manifest.runtime?.webPorts) && artifact.manifest.runtime.webPorts.length > 0) includesWebApp = true;
  }

  const version = args.version?.trim() || '1.0.0';
  const manifest: PackageManifest = {
    apiVersion:     'sulla/v1',
    kind:           'package',
    slug:           args.slug,
    name:           args.title.trim(),
    title:          args.title.trim(),
    topic:          args.topic?.trim() || undefined,
    app:            includesWebApp ? 'app' : 'none',
    where:          'desktop',
    version,
    description_md: args.description,
    contents,
  };
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-package-publish-'));
  const bundleRoot = path.join(tmpdir, args.slug);
  const zipPath = path.join(tmpdir, `${ args.slug }.zip`);
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, 'package.json'), `${ JSON.stringify(manifest, null, 2) }\n`, 'utf8');
  fs.writeFileSync(path.join(bundleRoot, 'README.md'), `# ${ args.title.trim() }\n\n${ args.description }\n`, 'utf8');
  try {
    await zipDirectory(bundleRoot, args.slug, zipPath);
    const submit = await submitManifest({ kind: 'package', name: args.title.trim(), description: args.description, version, tags: args.topic ? [args.topic] : [], manifest });
    const upload = await uploadBundle(submit.id, zipPath);
    return { templateId: submit.id, slug: submit.slug, bundle_status: upload.bundle_status, bundle_size: upload.bundle_size, status: upload.status };
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}

export { checkAgentManifestForPublish, findAgentSecret, hasAbsoluteHomePath } from './agentPublishSafety';
