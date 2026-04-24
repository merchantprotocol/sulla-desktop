import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { ARTIFACT_KINDS, ArtifactKind, artifactDir, isArtifactKind, resolveArtifactManifestPath } from './types';

/**
 * Compare a locally-installed artifact with the marketplace version. Shows
 * which files are added / removed / changed so the user can decide whether
 * to `marketplace/update` (overwrite local) or keep their edits.
 */
export class MarketplaceDiffWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ ARTIFACT_KINDS.join(', ') }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }

    const dir = artifactDir(kind, slug);
    if (!fs.existsSync(dir)) {
      return { successBoolean: false, responseString: `Not installed locally: ${ dir }` };
    }

    const localFiles = readLocalFileMap(kind, slug, dir);

    let remote;
    try {
      remote = await getMarketplaceClient().download(kind, slug);
    } catch (err) {
      return { successBoolean: false, responseString: `Could not fetch marketplace copy: ${ (err as Error).message }` };
    }

    const remoteFiles = buildRemoteFileMap(remote);

    const allKeys = new Set<string>([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const key of Array.from(allKeys).sort()) {
      const l = localFiles[key];
      const r = remoteFiles[key];
      if (l === undefined && r !== undefined) added.push(key);
      else if (l !== undefined && r === undefined) removed.push(key);
      else if (l !== r) changed.push(key);
      else unchanged.push(key);
    }

    const remoteVer = remote.version ? ` v${ remote.version }` : '';
    const summary = `Diff: local ${ kind }/${ slug } vs marketplace${ remoteVer }`;

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      return {
        successBoolean: true,
        responseString: `${ summary }\n  ✓ identical (${ unchanged.length } file(s) match)`,
      };
    }

    const lines: string[] = [summary];
    if (added.length > 0)   lines.push(`\nAdded in marketplace (${ added.length }) — \`marketplace/update\` will pull these:\n${ added.map(f => `  + ${ f }`).join('\n') }`);
    if (removed.length > 0) lines.push(`\nRemoved from marketplace (${ removed.length }) — local-only files; \`marketplace/update\` will leave them:\n${ removed.map(f => `  - ${ f }`).join('\n') }`);
    if (changed.length > 0) lines.push(`\nDiffering (${ changed.length }):\n${ changed.map(f => `  ~ ${ f }`).join('\n') }`);
    if (unchanged.length > 0) lines.push(`\n${ unchanged.length } file(s) identical.`);

    return {
      successBoolean: true,
      responseString: lines.join('\n'),
    };
  }
}

function readLocalFileMap(kind: ArtifactKind, slug: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};

  // Include the manifest under the canonical key
  const manifestPath = resolveArtifactManifestPath(kind, slug);
  if (manifestPath) {
    const rel = path.relative(dir, manifestPath);
    try { out[rel] = fs.readFileSync(manifestPath, 'utf-8'); } catch { /* skip */ }
  }

  walkLocal(dir, '', out, manifestPath ? path.basename(manifestPath) : null);
  return out;
}

function walkLocal(rootDir: string, relBase: string, out: Record<string, string>, manifestBasename: string | null) {
  const here = path.join(rootDir, relBase);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
    const rel = relBase ? path.join(relBase, entry.name) : entry.name;
    const abs = path.join(rootDir, rel);
    if (entry.isDirectory()) { walkLocal(rootDir, rel, out, manifestBasename); continue; }
    if (manifestBasename && rel === manifestBasename) continue; // already captured
    try { out[rel] = fs.readFileSync(abs, 'utf-8'); } catch {
      try { out[rel] = `base64:${ fs.readFileSync(abs).toString('base64') }`; } catch { /* skip */ }
    }
  }
}

function buildRemoteFileMap(remote: { manifest?: string; files?: Record<string, string>; manifestFilename?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  // Flatten: treat the manifest as just another file (keyed by filename if we have one).
  if (remote.manifest && remote.manifestFilename) {
    out[remote.manifestFilename] = remote.manifest;
  } else if (remote.manifest) {
    out['__manifest__'] = remote.manifest; // unnamed — diff still works on key match
  }
  for (const [k, v] of Object.entries(remote.files || {})) out[k] = v;
  return out;
}
