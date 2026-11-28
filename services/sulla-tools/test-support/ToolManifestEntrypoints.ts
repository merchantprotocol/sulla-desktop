// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { executionTargetFor } from '../../../packages/runtime-protocol/src/executionTargets';
import { ManifestEntryParser } from './ManifestEntryParser';
import { ModuleFiles } from './ModuleFiles';

const TOOLS_DIR = 'pkg/sulla-desktop/agent/tools';
const ENTRY_FILES = ['services/sulla-tools/src/index.ts', 'services/sulla-tools/src/catalog.ts'];

/**
 * Lists the entry files the Tools image runs: the service entrypoints plus the loader
 * of every manifest entry whose effective execution target is 'catalog'. Test support only.
 */
export class ToolManifestEntrypoints {
  constructor(
    private readonly root: string,
    private readonly parser = new ManifestEntryParser(),
    private readonly modules = new ModuleFiles(root),
  ) {}

  roots(): string[] {
    const loaders = this.manifestFiles().flatMap(manifest => this.catalogLoaders(manifest));
    return [...new Set([...ENTRY_FILES, ...loaders])];
  }

  private manifestFiles(): string[] {
    return readdirSync(path.join(this.root, TOOLS_DIR), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => `${ TOOLS_DIR }/${ entry.name }/manifests.ts`)
      .filter(manifest => existsSync(path.join(this.root, manifest)))
      .sort();
  }

  private catalogLoaders(manifest: string): string[] {
    const source = readFileSync(path.join(this.root, manifest), 'utf8');
    const loaders: string[] = [];
    for (const entry of this.parser.parse(source)) {
      if (!entry.category || !entry.name || !entry.loader) continue;
      // Same rule the registry applies: an explicit executionTarget wins, otherwise the shared mapping decides.
      const target = entry.executionTarget ?? executionTargetFor(entry.category, entry.name);
      if (target !== 'catalog') continue;
      const resolved = this.modules.resolve(manifest, entry.loader);
      if (!resolved) throw new Error(`Catalog loader ${ entry.loader } in ${ manifest } does not resolve to a file`);
      loaders.push(resolved);
    }
    return loaders;
  }
}
