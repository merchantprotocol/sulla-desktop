import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ModuleFiles } from './ModuleFiles';

/*
 * SCOPE OF THIS SCAN (read before changing it)
 *
 * Question answered: can the Tools image crash at module load because a file it actually runs
 * imports a path the Dockerfile does not COPY? That is the failure that `files/list` hit.
 *
 * 1. Roots are the Tools entrypoints (services/sulla-tools/src entry files + every catalog loader).
 *    Static edges from roots are checked. A static edge to a path that is not copied is a violation.
 * 2. Only FOLLOWED modules are walked further: pkg/sulla-desktop/agent/tools/**,
 *    pkg/sulla-desktop/agent/files/**, services/sulla-tools/src/**, plus override targets (below).
 *    Edges from followed modules into other copied trees (agent/languagemodels, agent/services,
 *    packages/*, ...) are not descended into. A missing copy there would only matter if a followed
 *    module statically evaluated it, and that is checked by the followed module's own edge list.
 * 3. Override targets (a file-to-file COPY, e.g. pendingCredentials.container.ts replacing
 *    main/firstRun/pendingCredentials.ts) are followed because the Dockerfile RUN executes them.
 *    Their text is read from the SOURCE file; their relative imports resolve from the DESTINATION path.
 *
 * Why not follow every static edge: esbuild (tsx) drops value imports whose bindings are only used as
 * types. A regex cannot see that elision, so a deep edge such as `agent/languagemodels/* -> @pkg/main/*`
 * can be reported even though the image never loads it at runtime. Narrowing the walk to the tool and
 * file loaders keeps the scan on the paths that have actually regressed.
 *
 * Also ignored: `import type` / `export type`, dynamic `import()` (run inside function bodies), and
 * comments (a word "import" in a doc comment followed later by a quoted path is not an edge).
 */

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
// Manifest `loader: () => import('./x')` targets are discovered as ROOTS by ToolManifestEntrypoints instead.
const STATIC_IMPORT = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?(['"])([^'"\n]+)\3/g;
const FOLLOWED_PREFIXES = [
  'pkg/sulla-desktop/agent/tools/',
  'pkg/sulla-desktop/agent/files/',
  'services/sulla-tools/src/',
];

/**
 * Walks runtime imports from the Tools entrypoints and reports each file that the
 * image reaches but does not copy. See the scope note at the top of this file.
 * Test support only: services/sulla-tools/test-support is never COPY'd into the image.
 */
export class ToolsImageImportBoundary {
  private readonly root: string;
  private readonly entrypoints: string[];
  private readonly modules: ModuleFiles;
  private readonly copiedPaths: string[] = [];
  /** Copied destination -> source file whose text the image runs at that destination. */
  private readonly overrideSources = new Map<string, string>();

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
        if (!this.isCopied(resolved)) {
          violations.add(`${ file } -> ${ resolved }`);
          continue;
        }
        if (this.isFollowed(resolved)) visit(resolved);
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
      const copiedPath = path.posix.normalize(destination);
      if (/\.tsx?$/.test(source) && this.isFile(source)) this.overrideSources.set(copiedPath, source);
      const isManifestOnly = source === 'package.json' || source === 'tsconfig.json';
      if (isManifestOnly && !this.isDirectory(source)) continue;
      this.copiedPaths.push(copiedPath);
    }
  }

  private isCopied(file: string): boolean {
    const normalized = path.posix.normalize(file);
    return this.copiedPaths.some(copied => normalized === copied || normalized.startsWith(`${ copied }/`));
  }

  private isFollowed(file: string): boolean {
    const normalized = path.posix.normalize(file);
    return this.overrideSources.has(normalized) || FOLLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix));
  }

  private isFile(relativePath: string): boolean {
    const absolute = path.join(this.root, relativePath);
    return existsSync(absolute) && statSync(absolute).isFile();
  }

  private isDirectory(relativePath: string): boolean {
    const absolute = path.join(this.root, relativePath);
    return existsSync(absolute) && statSync(absolute).isDirectory();
  }

  private runtimeImports(file: string): RuntimeImport[] {
    const sourceFile = this.overrideSources.get(path.posix.normalize(file)) ?? file;
    const code = stripComments(readFileSync(path.join(this.root, sourceFile), 'utf8'));
    const imports: RuntimeImport[] = [];
    for (const match of code.matchAll(STATIC_IMPORT)) imports.push({ specifier: match[4], typeOnly: Boolean(match[2]) });
    return imports;
  }
}

/** Blanks block comments and line comments so their prose cannot look like an import statement. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (_match, lead: string) => lead);
}
