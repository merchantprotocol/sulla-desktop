import fs from 'node:fs';
import path from 'node:path';

import { postgresClient } from './PostgresClient';

import { bundleToArtifact, readBundleFiles } from '@pkg/main/marketplace/databaseInstaller';
import type { InstallableKind } from '@pkg/main/marketplace/databaseInstaller';

export interface LegacyImportSummary {
  imported: number;
  skipped:  number;
  errors:   string[];
}

function artifactFolders(root: string): { slug: string; dir: string }[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({ slug: entry.name, dir: path.join(root, entry.name) }));
  } catch {
    return [];
  }
}

function bundledRoot(kind: 'skills' | 'integrations'): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'resources', kind) : '',
    path.resolve(__dirname, '../../../../../resources', kind),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

async function exists(kind: InstallableKind, slug: string): Promise<boolean> {
  const table = kind === 'routine' ? 'workflows' : `${ kind }_definitions`;
  const key = kind === 'routine' ? 'id' : 'slug';
  return !!(await postgresClient.queryOne(`SELECT 1 FROM ${ table } WHERE ${ key }=$1 LIMIT 1`, [slug]));
}

/** Everything the folder import has already handled, even if deleted since. */
async function seenSlugs(kind: InstallableKind): Promise<Set<string>> {
  const rows = await postgresClient.query('SELECT slug FROM legacy_artifact_import_ledger WHERE kind=$1', [kind]);
  return new Set(rows.map((row: { slug: string }) => row.slug));
}

async function markSeen(kind: InstallableKind, slug: string): Promise<void> {
  await postgresClient.query('INSERT INTO legacy_artifact_import_ledger (kind, slug) VALUES ($1, $2) ON CONFLICT (kind, slug) DO NOTHING', [kind, slug]);
}

function textFile(files: Record<string, any>, ...names: string[]): string | null {
  for (const name of names) if (typeof files[name] === 'string') return files[name];
  return null;
}

async function insertArtifact(kind: Exclude<InstallableKind, 'agent' | 'skill'>, slug: string, dir: string): Promise<boolean> {
  if (await exists(kind, slug)) return false;
  const files = readBundleFiles(dir);
  const artifact = bundleToArtifact(kind, files, slug);
  const manifest = artifact.manifest;
  const name = String(manifest.name ?? manifest.title ?? slug);
  const description = String(manifest.description ?? '');
  const version = manifest.version == null ? null : String(manifest.version);

  if (kind === 'routine') {
    manifest.id = slug;
    await postgresClient.query(`INSERT INTO workflows
      (id,name,description,version,status,definition,enabled,source_kind,user_edited)
      VALUES ($1,$2,$3,$4,'production',$5::jsonb,$6,'user',false) ON CONFLICT (id) DO NOTHING`,
    [slug, name, description, version, JSON.stringify(manifest), manifest.enabled !== false]);
  } else if (kind === 'function') {
    const runtime = String(manifest.spec?.runtime ?? manifest.runtime ?? '');
    await postgresClient.query(`INSERT INTO function_definitions
      (slug,name,description,manifest,runtime,files,source_kind,version,user_edited)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'user',$7,false) ON CONFLICT (slug) DO NOTHING`,
    [slug, name, description, JSON.stringify(manifest), runtime, JSON.stringify(files), version]);
  } else if (kind === 'integration') {
    manifest.id = slug;
    await postgresClient.query(`INSERT INTO integration_definitions
      (slug,name,description,manifest,files,source_kind,version,user_edited)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'user',$6,false) ON CONFLICT (slug) DO NOTHING`,
    [slug, name, description, JSON.stringify(manifest), JSON.stringify(files), version]);
  } else {
    const composeName = String(manifest.compose?.composeFile ?? manifest.composeFile ?? 'docker-compose.yml');
    const compose = textFile(files, composeName, 'docker-compose.yml', 'compose.yaml', 'compose.yml');
    if (!compose) throw new Error('compose file is missing');
    await postgresClient.query(`INSERT INTO recipe_definitions
      (slug,name,description,manifest,compose,files,source_kind,version,user_edited)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'user',$7,false) ON CONFLICT (slug) DO NOTHING`,
    [slug, name, description, JSON.stringify(manifest), compose, JSON.stringify(files), version]);
  }
  return true;
}

/**
 * Seeds the integration definitions that ship inside the app bundle.
 *
 * Jonathon (2026-10-15): nothing from the user's ~/sulla folders is copied
 * into Postgres at startup. Only app-shipped integrations are inserted, and
 * only when missing (existing rows always win; a slug is seeded once, so a
 * row deleted in Postgres stays deleted).
 */
export async function importLegacyArtifacts(): Promise<LegacyImportSummary> {
  const summary: LegacyImportSummary = { imported: 0, skipped: 0, errors: [] };
  const bundledIntegrations = bundledRoot('integrations');
  if (!bundledIntegrations) return summary;

  const seen = await seenSlugs('integration');
  for (const artifact of artifactFolders(bundledIntegrations)) {
    if (seen.has(artifact.slug)) {
      summary.skipped++;
      continue;
    }
    try {
      if (await insertArtifact('integration', artifact.slug, artifact.dir)) summary.imported++;
      else summary.skipped++;
      await markSeen('integration', artifact.slug);
    } catch (error) {
      summary.errors.push(`integration:${ artifact.slug }: ${ error instanceof Error ? error.message : String(error) }`);
    }
  }
  return summary;
}
