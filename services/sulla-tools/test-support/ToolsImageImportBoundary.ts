// SPDX-License-Identifier: GPL-2.0-or-later
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
 * 4. Dynamic `import('x')` with a string-literal specifier IS an edge. It runs inside a function body,
 *    but the Tools container still executes that body, so the target must be copied. Template literals
 *    and computed specifiers are not resolved (the scan reports only what it can name). Manifest
 *    `loader:` imports are the exception: they are roots (rule 1), selected by execution target.
 *
 * Ignored: `import type` / `export type`, `typeof import('x')` and `type X = import('x')` (type positions
 * that esbuild erases), and anything inside comments or string literals (a word "import" in prose or a
 * quoted `"import('@pkg/main/x')"` is not an edge). Comment and string detection uses CodeView below.
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

// Static edges: `import x from`, `import {..} from`, `import * as`, `import 'x'`, and `export ... from`.
// Matched on CodeView text, where string contents are blanked; the specifier is read back from source.
// Manifest `loader: () => import('./x')` targets are discovered as ROOTS by ToolManifestEntrypoints instead.
const STATIC_IMPORT = /\b(import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?(['"])/g;
// Dynamic `import('x')` edges. A lookbehind keeps `foo.import(` and `myimport(` out.
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*(['"])/g;
const TYPE_POSITION_PREFIX = /(?:\btypeof\s+|\btype\s+[\w$]+(?:<[^>]*>)?\s*=[^;]*)$/;
// Manifest files hold loader functions (`loader: () => import('./x')`, `loader: async() => ...`,
// `const load = () => import(...)`). The registry runs a loader only for catalog-target entries, and
// ToolManifestEntrypoints roots exactly those, so dynamic imports inside manifests are not walked.
const MANIFEST_FILE = /(?:^|\/)manifests\.ts$/;
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
    const source = readFileSync(path.join(this.root, sourceFile), 'utf8');
    const code = new CodeView(source);
    const imports: RuntimeImport[] = [];
    for (const match of code.text.matchAll(STATIC_IMPORT)) {
      const quoteAt = match.index + match[0].length - 1;
      imports.push({ specifier: code.literalAt(quoteAt), typeOnly: Boolean(match[2]) || isTypeOnlyClause(match[3]) });
    }
    if (MANIFEST_FILE.test(file)) return imports;
    for (const match of code.text.matchAll(DYNAMIC_IMPORT)) {
      const quoteAt = match.index + match[0].length - 1;
      const before = code.lineBefore(match.index);
      imports.push({ specifier: code.literalAt(quoteAt), typeOnly: TYPE_POSITION_PREFIX.test(before) });
    }
    return imports;
  }
}

/**
 * True when every binding in an import clause is a type (`{ type A, type B }`). esbuild drops such an
 * import entirely, so it never loads the module. A default or namespace binding is a value.
 */
function isTypeOnlyClause(clause: string | undefined): boolean {
  if (!clause) return false;
  const trimmed = clause.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  const specifiers = trimmed.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every(item => /^type\s+/.test(item));
}

/**
 * Source text with comments and string-literal contents blanked to spaces (newlines kept), so regexes
 * only see code. Length and offsets match the original, so `literalAt` can read the real specifier back.
 */
class CodeView {
  readonly text: string;

  constructor(private readonly source: string) {
    this.text = blankNonCode(source);
  }

  /** Specifier of the string literal whose opening quote sits at `quoteAt`. */
  literalAt(quoteAt: number): string {
    const quote = this.source[quoteAt];
    const close = this.text.indexOf(quote, quoteAt + 1);
    return close === -1 ? '' : this.source.slice(quoteAt + 1, close);
  }

  /** Code on the same line, before `index`. */
  lineBefore(index: number): string {
    const lineStart = this.text.lastIndexOf('\n', index - 1) + 1;
    return this.text.slice(lineStart, index);
  }
}

/** Single pass over the source: blanks comments and string/template contents; keeps quote delimiters. */
function blankNonCode(source: string): string {
  const out = source.split('');
  const blank = (index: number): void => { if (out[index] !== '\n') out[index] = ' '; };
  // Brace depth of the code we are in; a stack of enclosing depths for each open `${ ... }` substitution.
  const substitutions: number[] = [];
  let depth = 0;
  let mode: 'code' | 'line' | 'block' | 'string' | 'template' = 'code';
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (mode === 'line') {
      if (char === '\n') mode = 'code';
      else blank(i);
      continue;
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') { blank(i); blank(i + 1); i++; mode = 'code'; }
      else blank(i);
      continue;
    }
    if (mode === 'string' || mode === 'template') {
      if (char === '\\') { blank(i); blank(i + 1); i++; continue; }
      if (mode === 'string' && (char === quote || char === '\n')) { mode = 'code'; continue; }
      if (mode === 'template' && char === '`') { mode = 'code'; continue; }
      if (mode === 'template' && char === '$' && next === '{') {
        substitutions.push(depth);
        depth = 0;
        mode = 'code';
        i++;
        continue;
      }
      blank(i);
      continue;
    }
    if (char === '/' && next === '/') { mode = 'line'; blank(i); blank(i + 1); i++; continue; }
    if (char === '/' && next === '*') { mode = 'block'; blank(i); blank(i + 1); i++; continue; }
    if (char === '\'' || char === '"') { mode = 'string'; quote = char; continue; }
    if (char === '`') { mode = 'template'; continue; }
    if (char === '{') depth++;
    if (char === '}') {
      if (depth === 0 && substitutions.length > 0) {
        depth = substitutions.pop() as number;
        mode = 'template';
        continue;
      }
      depth--;
    }
  }
  return out.join('');
}
