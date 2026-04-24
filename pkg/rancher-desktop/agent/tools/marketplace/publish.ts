import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { artifactDir, isArtifactKind, KIND_LAYOUTS, ArtifactKind, resolveArtifactManifestPath } from './types';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file safety cap
const TEXT_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.json', '.py', '.js', '.ts', '.sh', '.txt', '.toml', '.html', '.css', '.svg']);

/**
 * Publish a local artifact to the Sulla Cloud marketplace.
 * Bundles the manifest + companion files and POSTs to the marketplace API.
 */
export class MarketplacePublishWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const version = typeof input.version === 'string' ? input.version.trim() : undefined;

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: skill, function, workflow, agent, recipe, integration.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: `Missing required field: slug.` };
    }

    const dir = artifactDir(kind, slug);
    if (!fs.existsSync(dir)) {
      return { successBoolean: false, responseString: `Not installed locally: ${ dir }` };
    }

    const manifestPath = resolveArtifactManifestPath(kind, slug);
    if (!manifestPath) {
      return { successBoolean: false, responseString: `Manifest missing in ${ dir } — cannot publish.` };
    }

    const manifest = fs.readFileSync(manifestPath, 'utf-8');
    const manifestName = path.basename(manifestPath);
    const files = collectFiles(kind, dir, manifestName);

    try {
      const result = await getMarketplaceClient().publish({ kind, slug, version, manifest, files });
      return {
        successBoolean: true,
        responseString: `Published ${ kind }/${ slug } v${ result.version } → ${ result.url }`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (/HTTP 401|HTTP 403/.test(msg)) {
        return { successBoolean: false, responseString: `Publish failed (auth): ${ msg }\nConfigure your Sulla Cloud token: \`sulla vault/vault_set_credential '{"account_type":"sulla-cloud","property":"api_token","value":"..."}'\`` };
      }
      if (/ECONNREFUSED|HTTP 404|fetch failed/i.test(msg)) {
        return { successBoolean: false, responseString: `Publish failed: marketplace API not reachable. The Sulla Cloud marketplace worker may not be deployed yet, or the URL is wrong.\n\nUnderlying error: ${ msg }` };
      }
      return { successBoolean: false, responseString: `Publish failed: ${ msg }` };
    }
  }
}

function collectFiles(_kind: ArtifactKind, dir: string, manifestName: string): Record<string, string> {
  void KIND_LAYOUTS;
  const out: Record<string, string> = {};
  walk(dir, '', out, manifestName);
  return out;
}

function walk(rootDir: string, relBase: string, out: Record<string, string>, manifestName: string) {
  const here = path.join(rootDir, relBase);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;

    const rel = relBase ? path.join(relBase, entry.name) : entry.name;

    if (entry.isDirectory()) {
      walk(rootDir, rel, out, manifestName);
      continue;
    }
    if (rel === manifestName) continue; // manifest is already sent separately

    const abs = path.join(rootDir, rel);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) {
      out[rel] = `__SKIPPED__:${ stat.size } bytes exceeds ${ MAX_FILE_BYTES } cap`;
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext) || stat.size === 0) {
      try { out[rel] = fs.readFileSync(abs, 'utf-8'); continue; } catch { /* fall through */ }
    }
    try { out[rel] = `base64:${ fs.readFileSync(abs).toString('base64') }`; } catch { /* skip unreadable */ }
  }
}
