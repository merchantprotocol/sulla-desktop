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

import type { AgentMarketplaceManifest } from '@pkg/agent/services/AgentDefinitionService';
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
  let agentStagingDir: string | null = null;
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

    agentStagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-agent-publish-'));
    try {
      effectiveSourceDir = path.join(agentStagingDir, slug);
      fs.mkdirSync(effectiveSourceDir, { recursive: true });
      fs.writeFileSync(path.join(effectiveSourceDir, 'agent.json'), serialized, 'utf8');
      fs.writeFileSync(
        path.join(effectiveSourceDir, 'README.md'),
        `# ${ manifest.metadata.title }\n\n${ manifest.metadata.description || 'Sulla database-backed custom agent.' }\n`,
        'utf8',
      );
    } catch (err) {
      fs.rmSync(agentStagingDir, { recursive: true, force: true });
      throw err;
    }
  }

  if (!fs.existsSync(effectiveSourceDir) || !fs.statSync(effectiveSourceDir).isDirectory()) {
    throw new Error(`bundle source does not exist: ${ effectiveSourceDir }`);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = buildManifest(kind, { slug, bundleRoot: effectiveSourceDir, overrides });
  } catch (err) {
    if (agentStagingDir) fs.rmSync(agentStagingDir, { recursive: true, force: true });
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
    if (agentStagingDir) fs.rmSync(agentStagingDir, { recursive: true, force: true });
  }
}

const AGENT_SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{10,}/ },
  { label: 'GitHub token', pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: 'AWS access key', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: 'Slack token', pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}/ },
  { label: 'private key', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
];

export function findAgentSecret(agentJson: string): string | null {
  return AGENT_SECRET_PATTERNS.find(candidate => candidate.pattern.test(agentJson))?.label ?? null;
}

export function hasAbsoluteHomePath(prompt: string): boolean {
  return /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/.test(prompt);
}

/** Every text field that ships in agent.json: prompt, soul, goals and each prompt file. */
function agentTextFields(manifest: AgentMarketplaceManifest): string[] {
  const spec = manifest.spec ?? ({} as AgentMarketplaceManifest['spec']);

  return [spec.prompt, spec.soul, spec.goals, ...Object.values(spec.promptFiles ?? {})].filter((v): v is string => typeof v === 'string');
}

/** Pre-publish check shared by the publish path and the Agents tab confirm step. */
export function checkAgentManifestForPublish(manifest: AgentMarketplaceManifest): { secret: string | null; warnings: string[] } {
  const warnings: string[] = [];

  if (agentTextFields(manifest).some(hasAbsoluteHomePath)) {
    warnings.push('The agent contains absolute home-directory paths (e.g. /Users/<name>/). They may not work on other machines.');
  }

  return { secret: findAgentSecret(JSON.stringify(manifest)), warnings };
}
