import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { KINDS_HELP, normalizeKind, toMarketplaceKind } from './types';

/**
 * Compare a local artifact with the latest marketplace version, file by
 * file. Read-only — the marketplace copy is extracted to a temp dir and
 * removed afterwards.
 */
export class MarketplaceDiffWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = normalizeKind(input.kind);
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

    if (!kind) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: ${ KINDS_HELP }.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: 'Missing required field: slug.' };
    }

    let latest;
    try {
      latest = await getMarketplaceClient().fetchLatest(kind, slug);
    } catch (err) {
      return { successBoolean: false, responseString: `Could not fetch marketplace copy: ${ (err as Error).message }` };
    }

    let exported: { dir: string; cleanup: () => void } | null = null;
    try {
      const marketplaceKind = toMarketplaceKind(kind);
      if (!marketplaceKind) return { successBoolean: false, responseString: `Unsupported artifact kind: ${ kind }` };
      const { materializeDatabaseArtifact, readDatabaseArtifact } = await import('@pkg/main/marketplace/databaseArtifacts');
      const artifact = await readDatabaseArtifact(marketplaceKind as any, slug);
      exported = materializeDatabaseArtifact(artifact);
      const localDir = exported.dir;

      const { isExcludedFromBundle } = await import('@pkg/main/marketplace/bundleFiles');
      const localFiles = readTree(localDir, isExcludedFromBundle);
      const remoteFiles = readTree(latest.rootPath, isExcludedFromBundle);

      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];
      let unchanged = 0;
      for (const key of Array.from(new Set([...localFiles.keys(), ...remoteFiles.keys()])).sort()) {
        const l = localFiles.get(key);
        const r = remoteFiles.get(key);
        if (!l && r) added.push(key);
        else if (l && !r) removed.push(key);
        else if (l && r && !l.equals(r)) changed.push(key);
        else unchanged++;
      }

      const localVer = latest.listing.installed ? ` (installed v${ latest.listing.installed.version })` : '';
      const summary = `Diff: local ${ input.kind }/${ slug }${ localVer } vs marketplace v${ latest.listing.version } — ${ localDir }`;

      if (added.length + removed.length + changed.length === 0) {
        return { successBoolean: true, responseString: `${ summary }\n  ✓ identical (${ unchanged } file(s) match)` };
      }

      const lines = [summary];
      if (added.length > 0) lines.push(`\nOnly in marketplace (${ added.length }) — \`marketplace/update\` adds these:\n${ added.map(f => `  + ${ f }`).join('\n') }`);
      if (removed.length > 0) lines.push(`\nOnly local (${ removed.length }) — \`marketplace/update\` replaces the folder, so these would be removed:\n${ removed.map(f => `  - ${ f }`).join('\n') }`);
      if (changed.length > 0) lines.push(`\nDiffering (${ changed.length }) — \`marketplace/update\` overwrites local edits:\n${ changed.map(f => `  ~ ${ f }`).join('\n') }`);
      if (unchanged > 0) lines.push(`\n${ unchanged } file(s) identical.`);

      return { successBoolean: true, responseString: lines.join('\n') };
    } finally {
      exported?.cleanup();
      latest.cleanup();
    }
  }
}

function readTree(root: string, excluded: (name: string, isDir: boolean) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (excluded(e.name, e.isDirectory())) continue;
      const childRel = rel ? `${ rel }/${ e.name }` : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) {
        try { out.set(childRel, fs.readFileSync(path.join(root, childRel))) } catch { /* unreadable → treat as absent */ }
      }
    }
  }

  return out;
}
