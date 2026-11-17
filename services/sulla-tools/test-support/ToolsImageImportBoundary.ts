import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ModuleFiles } from './ModuleFiles';

export interface ToolsImageImportBoundaryOptions {
  /** Repo root that the Dockerfile's COPY sources are relative to. */
  root: string;
  /** Full text of services/sulla-tools/Dockerfile. */
  dockerfile: string;
  /** Repo-relative files the Tools image executes. */
  entrypoints: string[];
}

interface RuntimeImport { specifier: string; typeOnly: boolean }

// Static edges only: `import x from`, `import {..} from`, `import * as`, `import 'x'`, and `export ... from`.
// Dynamic `import()` expressions are deliberately NOT followed. They run inside function bodies
// (e.g. a runtime-guarded seam that only executes on Desktop), so they are not evaluated when the
// Tools entrypoints load. A missing copied path only breaks the image when a static edge pulls it in
// at module evaluation. Manifest `loader: () => import('./x')` targets are discovered as ROOTS by
// ToolManifestEntrypoints instead.
const STATIC_IMPORT = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?(['"])([^'"\n]+)\3/g;
const OVERRIDE_SOURCE = 'services/sulla-tools/src/pendingCredentials.container.ts';
const OVERRIDE_TARGET = 'pkg/sulla-desktop/main/firstRun/pendingCredentials.ts';

/**
 * Walks runtime imports from the Tools entrypoints and reports each file that the
 * image reaches but does not copy. Type-only imports are ignored.
 * Test support only: services/sulla-tools/test-support is never COPY'd into the image.
 */
export class ToolsImageImportBoundary {
  private readonly root: string;
  private readonly entrypoints: string[];
  private readonly modules: ModuleFiles;
  private readonly copiedPaths: string[] = [];
  private readonly overrideTargets = new Set<string>();

  constructor(options: ToolsImageImportBoundaryOptions) {
    this.root = options.root;
    this.entrypoints = [...options.entrypoints];
    this.modules = new ModuleFiles(options.root);
    this.readCopyInstructions(options.dockerfile);
  }

  /** `importer -> imported` pairs for runtime imports that resolve outside the copied paths. */
  violations(): string[] {
    const seen = new Set<string>();
    const violations = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const dependency of this.runtimeImports(file)) {
        if (dependency.typeOnly) continue;
        const resolved = this.modules.resolve(file, dependency.specifier);
        if (!resolved) continue;
        if (this.isCopied(resolved)) visit(resolved);
        else violations.add(`${ file } -> ${ resolved }`);
      }
    };
    this.entrypoints.forEach(visit);
    return [...violations].sort();
  }

  private readCopyInstructions(dockerfile: string): void {
    for (const line of dockerfile.split(/\r?\n/)) {
      const copy = /^COPY\s+(\S+)\s+(\S+)\s*$/.exec(line);
      if (!copy || copy[1].startsWith('--')) continue;
      const [, source, destination] = copy;
      if (source === OVERRIDE_SOURCE) this.overrideTargets.add(OVERRIDE_TARGET);
      const isManifestOnly = source === 'package.json' || source === 'tsconfig.json';
      if (isManifestOnly && !this.isDirectory(source)) continue;
      this.copiedPaths.push(path.posix.normalize(destination));
    }
  }

  private isCopied(file: string): boolean {
    const normalized = path.posix.normalize(file);
    return this.overrideTargets.has(normalized)
      || this.copiedPaths.some(copied => normalized === copied || normalized.startsWith(`${ copied }/`));
  }

  private isDirectory(relativePath: string): boolean {
    const absolute = path.join(this.root, relativePath);
    return existsSync(absolute) && statSync(absolute).isDirectory();
  }

  private runtimeImports(file: string): RuntimeImport[] {
    const source = readFileSync(path.join(this.root, file), 'utf8');
    const imports: RuntimeImport[] = [];
    for (const match of source.matchAll(STATIC_IMPORT)) imports.push({ specifier: match[4], typeOnly: Boolean(match[2]) });
    return imports;
  }
}
