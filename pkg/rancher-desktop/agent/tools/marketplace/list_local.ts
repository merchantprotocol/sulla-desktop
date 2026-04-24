import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { ARTIFACT_KINDS, ArtifactKind, isArtifactKind, KIND_LAYOUTS } from './types';

/**
 * Enumerate locally-installed artifacts. Filterable by kind.
 */
export class MarketplaceListLocalWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kindRaw = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const kinds: readonly ArtifactKind[] = kindRaw
      ? (isArtifactKind(kindRaw) ? [kindRaw] : [])
      : ARTIFACT_KINDS;

    if (kinds.length === 0) {
      return { successBoolean: false, responseString: `Invalid kind "${ kindRaw }". Must be one of: ${ ARTIFACT_KINDS.join(', ') }.` };
    }

    const blocks: string[] = [];
    let total = 0;

    for (const kind of kinds) {
      const layout = KIND_LAYOUTS[kind];
      const root = layout.rootDir();
      const items: { slug: string; manifestExists: boolean }[] = [];

      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const manifestExists = fs.existsSync(path.join(root, entry.name, layout.manifest));
          items.push({ slug: entry.name, manifestExists });
        }
      } catch {
        // Dir doesn't exist or unreadable — show as empty.
      }

      total += items.length;
      if (items.length === 0) {
        blocks.push(`### ${ kind } (0)\n  ${ root } — empty`);
      } else {
        const lines = items.map(i => `  - ${ i.slug }${ i.manifestExists ? '' : ' ⚠️ (missing manifest)' }`);
        blocks.push(`### ${ kind } (${ items.length })\n  ${ root }\n${ lines.join('\n') }`);
      }
    }

    return {
      successBoolean: true,
      responseString: `Locally installed artifacts (${ total } total):\n\n${ blocks.join('\n\n') }`,
    };
  }
}
