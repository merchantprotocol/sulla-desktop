import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { getMarketplaceClient } from './MarketplaceClient';
import { artifactDir, isArtifactKind, KIND_LAYOUTS } from './types';

export class MarketplaceDownloadWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const overwrite = input.overwrite === true;

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: skill, function, workflow, agent, recipe, integration.` };
    }
    if (!slug) {
      return { successBoolean: false, responseString: `Missing required field: slug.` };
    }

    const targetDir = artifactDir(kind, slug);
    if (fs.existsSync(targetDir) && !overwrite) {
      return {
        successBoolean: false,
        responseString: `Already installed at ${ targetDir }. Pass {"overwrite":true} to replace.`,
      };
    }

    try {
      const result = await getMarketplaceClient().download(kind, slug);

      fs.mkdirSync(targetDir, { recursive: true });

      const layout = KIND_LAYOUTS[kind];
      const written: string[] = [];

      // Resolve the manifest filename. For static manifests, it's the layout
      // value. For dynamic manifests (integration), the cloud response's
      // `manifestFilename` tells us; falls back to `<slug>.v1-auth.yaml`.
      let manifestFilename: string;
      if (layout.manifest !== 'dynamic') {
        manifestFilename = layout.manifest;
      } else {
        const anyResult = result as unknown as { manifestFilename?: string };
        manifestFilename = anyResult.manifestFilename || `${ slug }.v1-auth.yaml`;
      }

      // Write the manifest (if the cloud actually returned one).
      if (result.manifest) {
        const manifestPath = path.join(targetDir, manifestFilename);
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, result.manifest, 'utf-8');
        written.push(manifestFilename);
      }

      // Write companion files. base64: prefix means binary.
      for (const [relPath, contents] of Object.entries(result.files || {})) {
        const filePath = path.join(targetDir, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (contents.startsWith('base64:')) {
          fs.writeFileSync(filePath, Buffer.from(contents.slice(7), 'base64'));
        } else {
          fs.writeFileSync(filePath, contents, 'utf-8');
        }
        written.push(relPath);
      }

      return {
        successBoolean: true,
        responseString: `Downloaded ${ kind }/${ slug }${ result.version ? ` v${ result.version }` : '' } to ${ targetDir }\n` +
          `Files written (${ written.length }):\n${ written.map(f => `  - ${ f }`).join('\n') }`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Marketplace download failed: ${ (err as Error).message }` };
    }
  }
}
