import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { artifactDir, KINDS_HELP, normalizeKind } from './types';

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

    try {
      if (kind === 'agent') return await diffAgent(slug, latest);

      const localDir = latest.listing.installed?.path ?? artifactDir(kind, slug);
      if (!fs.existsSync(localDir)) {
        return { successBoolean: false, responseString: `Not installed locally: ${ localDir }` };
      }

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
      latest.cleanup();
    }
  }
}

async function diffAgent(
  slug: string,
  latest: Awaited<ReturnType<ReturnType<typeof getMarketplaceClient>['fetchLatest']>>,
): Promise<ToolResponse> {
  const { agentDefinitionService } = await import('../../services/AgentDefinitionService');
  const local = await agentDefinitionService.findBySlug(slug);
  if (!local) return { successBoolean: false, responseString: `Agent ${ slug } is not installed in the database.` };

  const remotePath = path.join(latest.rootPath, 'agent.json');
  if (!fs.existsSync(remotePath)) {
    return { successBoolean: false, responseString: `Marketplace bundle is missing ${ slug }/agent.json.` };
  }

  let remote: unknown;
  try {
    remote = JSON.parse(fs.readFileSync(remotePath, 'utf8'));
  } catch (err) {
    return { successBoolean: false, responseString: `Marketplace agent.json is invalid: ${ (err as Error).message }` };
  }

  const localFields = flattenFields(agentDefinitionService.toManifest(local));
  const remoteFields = flattenFields(remote);
  const lines: string[] = [];
  let unchanged = 0;
  for (const field of Array.from(new Set([...localFields.keys(), ...remoteFields.keys()])).sort()) {
    if (!localFields.has(field)) lines.push(`  + ${ field } (marketplace only)`);
    else if (!remoteFields.has(field)) lines.push(`  - ${ field } (local only)`);
    else if (localFields.get(field) !== remoteFields.get(field)) lines.push(`  ~ ${ field }`);
    else unchanged++;
  }

  const heading = `Diff: database agent/${ slug } vs marketplace v${ latest.listing.version }`;
  if (lines.length === 0) {
    return { successBoolean: true, responseString: `${ heading }\n  ✓ identical (${ unchanged } field(s) match)` };
  }

  return { successBoolean: true, responseString: `${ heading }\n${ lines.join('\n') }\n\n${ unchanged } field(s) identical.` };
}

function flattenFields(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, '[]');
    value.forEach((entry, index) => flattenFields(entry, `${ prefix }[${ index }]`, out));
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) out.set(prefix, '{}');
    entries.forEach(([key, entry]) => flattenFields(entry, prefix ? `${ prefix }.${ key }` : key, out));
  } else {
    out.set(prefix, JSON.stringify(value));
  }

  return out;
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
