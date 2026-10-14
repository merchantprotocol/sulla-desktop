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
import { checkAgentManifestForPublish } from './agentPublishSafety';

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
  status:        'pending' | 'approved';
  warnings?:     string[];
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
  sourceDir?: string;
  slug:       string;
  overrides?: PublishOverrides;
}): Promise<PublishResult> {
  const { kind, sourceDir, slug, overrides } = args;
  let effectiveSourceDir = sourceDir ?? '';
  let stagingDir: string | null = null;
  const warnings: string[] = [];

  if (kind === 'agent') {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    const agent = await agentDefinitionService.findBySlug(slug);

    if (!agent) throw new Error(`Agent not found in the database: ${ slug }`);
    const manifest = agentDefinitionService.toManifest(agent);
    const serialized = `${ JSON.stringify(manifest, null, 2) }\n`;
    const check = checkAgentManifestForPublish(manifest);

    if (check.secret) {
      throw new Error(`agent.json contains a possible ${ check.secret } secret. Remove credentials from the agent before publishing.`);
    }
    warnings.push(...check.warnings);

    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-agent-publish-'));
    try {
      effectiveSourceDir = path.join(stagingDir, slug);
      fs.mkdirSync(effectiveSourceDir, { recursive: true });
      fs.writeFileSync(path.join(effectiveSourceDir, 'agent.json'), serialized, 'utf8');
      fs.writeFileSync(
        path.join(effectiveSourceDir, 'README.md'),
        `# ${ manifest.metadata.title }\n\n${ manifest.metadata.description || 'Sulla database-backed custom agent.' }\n`,
        'utf8',
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }

  if (!fs.existsSync(effectiveSourceDir) || !fs.statSync(effectiveSourceDir).isDirectory()) {
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
  }
}

export { checkAgentManifestForPublish, findAgentSecret, hasAbsoluteHomePath } from './agentPublishSafety';
