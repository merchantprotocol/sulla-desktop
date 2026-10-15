/** Database-only marketplace install pipeline. Bundle extraction is temporary. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as yauzl from 'yauzl';

import { fetchPublicTemplate, publicFetch, type MarketplaceKind } from './client';

import { MARKETPLACE_KINDS as MARKETPLACE_KIND_DEFINITIONS } from '@pkg/composables/marketplaceKinds';

export const MARKETPLACE_KINDS: MarketplaceKind[] = MARKETPLACE_KIND_DEFINITIONS.map(entry => entry.kind);

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export interface InstalledArtifact {
  templateId:  string;
  kind:        MarketplaceKind;
  slug:        string;
  name:        string;
  version:     string;
  installedAt: string;
  path:        string;
}

export interface InstallResult {
  kind:              MarketplaceKind;
  slug:              string;
  path:              string;
  name:              string;
  version:           string;
  alreadyInstalled?: boolean;
  previousVersion?:  string;
  updated?:          boolean;
  warnings?:         string[];
}

function rmrfSync(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function rejectEntry(entry: yauzl.Entry): string | null {
  const name = entry.fileName;
  if (!name || name.includes('\\') || path.isAbsolute(name) || name.startsWith('/') || name.includes('\0') || name.split('/').includes('..')) {
    return `unsafe bundle path: ${ name }`;
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (unixMode && (unixMode & 0o170000) === 0o120000) return `symlink entries are not allowed: ${ name }`;
  if (entry.uncompressedSize > MAX_FILE_BYTES) return `entry exceeds max file size: ${ name }`;
  return null;
}

function extractZipSafely(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error('failed to open zip'));
      let entries = 0;
      let bytes = 0;
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        entries++;
        bytes += entry.uncompressedSize;
        const error = entries > MAX_ENTRIES ? 'zip has too many entries' : bytes > MAX_TOTAL_BYTES ? 'bundle total size exceeds cap' : rejectEntry(entry);
        if (error) { zip.close(); reject(new Error(error)); return }
        const output = path.join(destDir, entry.fileName);
        const resolved = path.resolve(output);
        if (!resolved.startsWith(`${ path.resolve(destDir) }${ path.sep }`)) { zip.close(); reject(new Error(`entry escapes destination: ${ entry.fileName }`)); return }
        if (entry.fileName.endsWith('/')) { fs.mkdirSync(output, { recursive: true }); zip.readEntry(); return }
        fs.mkdirSync(path.dirname(output), { recursive: true });
        zip.openReadStream(entry, (streamError, input) => {
          if (streamError || !input) { zip.close(); reject(streamError ?? new Error('failed to read zip entry')); return }
          const out = fs.createWriteStream(output);
          out.on('error', reject);
          out.on('close', () => zip.readEntry());
          input.on('error', reject);
          input.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

async function downloadBundleToTmp(id: string): Promise<{ zipPath: string; tmpdir: string }> {
  const response = await publicFetch(`/marketplace/templates/${ encodeURIComponent(id) }/download`);
  if (!response.ok) throw new Error(`download failed: ${ response.status } ${ response.statusText }`);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('zip') || !response.body) throw new Error('marketplace download is not a zip bundle');
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-marketplace-'));
  const zipPath = path.join(tmpdir, 'bundle.zip');
  const out = fs.createWriteStream(zipPath);
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) throw new Error('download exceeded max bundle size');
      if (!out.write(Buffer.from(value))) await new Promise<void>(resolve => out.once('drain', resolve));
    }
    await new Promise<void>(resolve => out.end(resolve));
    return { zipPath, tmpdir };
  } catch (error) {
    out.destroy();
    rmrfSync(tmpdir);
    throw error;
  }
}

export async function fetchAndExtract(templateId: string): Promise<{ tmpdir: string; rootPath: string; dirName: string }> {
  const downloaded = await downloadBundleToTmp(templateId);
  try {
    const stageDir = path.join(downloaded.tmpdir, 'staged');
    fs.mkdirSync(stageDir, { recursive: true });
    await extractZipSafely(downloaded.zipPath, stageDir);
    const entries = fs.readdirSync(stageDir, { withFileTypes: true });
    const dirs = entries.filter(entry => entry.isDirectory());
    if (dirs.length !== 1 || entries.some(entry => !entry.isDirectory())) throw new Error('bundle must contain exactly one top-level directory');
    return { tmpdir: downloaded.tmpdir, rootPath: path.join(stageDir, dirs[0].name), dirName: dirs[0].name };
  } catch (error) {
    rmrfSync(downloaded.tmpdir);
    throw error;
  }
}

export async function installTemplate(templateId: string, opts: { overwrite?: boolean; replaces?: string } = {}): Promise<InstallResult> {
  if (!templateId) throw new Error('template id is required');
  const detail = await fetchPublicTemplate(templateId);
  if (!MARKETPLACE_KINDS.includes(detail.kind)) throw new Error(`Unknown marketplace kind "${ detail.kind }"`);

  if (detail.kind === 'package') {
    const { installPackageManifest } = await import('./databaseInstaller');
    const result = await installPackageManifest(detail.id, detail.manifest, detail.author_display);
    return {
      kind:     detail.kind,
      slug:     result.package.slug,
      path:     `database:installed_packages/${ result.package.slug }`,
      name:     detail.name ?? result.package.slug,
      version:  result.package.version,
      warnings: result.skipped.map(item => `${ item.kind } "${ item.slug }" skipped: ${ item.reason }`),
    };
  }

  if (detail.kind === 'agent') {
    const { installStandaloneArtifact } = await import('./databaseInstaller');
    const outcome = await installStandaloneArtifact(detail, { manifest: detail.manifest as Record<string, any>, files: {} }, opts.overwrite === true);
    return {
      kind:             detail.kind,
      slug:             detail.slug,
      path:             `database:agent_definitions/${ detail.slug }`,
      name:             detail.name ?? detail.slug,
      version:          detail.version,
      alreadyInstalled: !outcome.installed,
      updated:          opts.overwrite === true && outcome.installed,
      ...(outcome.reason ? { warnings: [outcome.reason] } : {}),
    };
  }

  const extracted = await fetchAndExtract(templateId);
  try {
    const { bundleToArtifact, installStandaloneArtifact, readBundleFiles } = await import('./databaseInstaller');
    const artifact = bundleToArtifact(detail.kind, readBundleFiles(extracted.rootPath), detail.slug);
    const outcome = await installStandaloneArtifact(detail, artifact, opts.overwrite === true);
    return {
      kind:             detail.kind,
      slug:             detail.slug,
      path:             `database:${ detail.kind === 'routine' ? 'workflows' : `${ detail.kind }_definitions` }/${ detail.slug }`,
      name:             detail.name ?? detail.slug,
      version:          detail.version,
      alreadyInstalled: !outcome.installed,
      updated:          opts.overwrite === true && outcome.installed,
      ...(outcome.reason ? { warnings: [outcome.reason] } : {}),
    };
  } finally {
    rmrfSync(extracted.tmpdir);
  }
}

type DependencyKind = 'agent' | 'skill' | 'integration' | 'function';

function dependencySlug(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof (value as any).slug === 'string') return (value as any).slug.trim();
  return '';
}

export async function installTemplateWithDependencies(templateId: string, opts: { overwrite?: boolean; replaces?: string } = {}): Promise<InstallResult> {
  const detail = await fetchPublicTemplate(templateId);
  const result = await installTemplate(templateId, opts);
  if (detail.kind !== 'routine') return result;
  const summary = (detail.manifest?.routineSummary ?? {}) as Record<string, unknown>;
  const groups: [DependencyKind, unknown][] = [
    ['agent', summary.requiredAgents], ['skill', summary.requiredSkills],
    ['integration', summary.requiredIntegrations], ['function', summary.requiredFunctions],
  ];
  const warnings = [...(result.warnings ?? [])];
  const seen = new Set<string>();
  const { findTemplateBySlug } = await import('./client');
  for (const [kind, values] of groups) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const slug = dependencySlug(value);
      const key = `${ kind }:${ slug }`;
      if (!slug || seen.has(key)) continue;
      seen.add(key);
      try {
        const listing = await findTemplateBySlug(kind, slug);
        if (!listing) warnings.push(`${ kind } "${ slug }" is required but unavailable; skipped.`);
        else await installTemplate(listing.id);
      } catch (error) {
        warnings.push(`${ kind } "${ slug }" could not be installed: ${ error instanceof Error ? error.message : String(error) }`);
      }
    }
  }
  return { ...result, ...(warnings.length ? { warnings } : {}) };
}

export async function listInstalledIncludingAgents(kinds: MarketplaceKind[] = MARKETPLACE_KINDS): Promise<InstalledArtifact[]> {
  const { listInstalledArtifacts } = await import('./databaseInstaller');
  const allowed = new Set(kinds.filter(kind => kind !== 'package'));
  return (await listInstalledArtifacts()).filter(item => allowed.has(item.kind)) as InstalledArtifact[];
}
