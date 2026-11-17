import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { BuildOptions, Metafile, Plugin } from 'esbuild';

/*
 * WHAT THIS MEASURES
 *
 * The modules the Tools container actually loads, as esbuild (the same transform tsx uses) sees them.
 * Roots are the Tools entrypoints and every catalog loader (see ToolManifestEntrypoints). The graph is
 * bundled with the repo tsconfig `paths` (so `@pkg/*` resolves like it does at runtime), node builtins
 * and npm packages marked external, and static + literal dynamic imports followed. esbuild drops imports
 * whose bindings are only used as types, so `import type` and type-only uses are not inputs here.
 *
 * Two things mirror the Dockerfile rather than the source tree:
 *  - Override COPYs (a `.ts` source copied onto a `.ts` destination, e.g. pendingCredentials.container.ts
 *    replacing main/firstRun/pendingCredentials.ts) are what the image runs at that destination, so the
 *    destination loads the source text, and its relative imports resolve from the destination folder.
 *  - Anything under pkg/sulla-desktop/{main,backend,window,pages} is reported as a loaded input. The
 *    image never copies those trees except through an override, so each such input is a crash at load.
 *
 * Limits: a non-literal `import(x)` cannot be named statically and is not followed. Dynamic literal
 * imports inside function bodies are followed, because the container runs those bodies too.
 * Test support only: services/sulla-tools/test-support is never COPY'd into the image.
 */

// Manifest files whose dynamic import() loaders run only for catalog-target entries (see plugin()).
const MANIFEST_IMPORTER = /(?:^|\/)(?:manifests|allManifests)\.ts$/;

export const SENSITIVE_INPUT_PREFIXES = [
  'pkg/sulla-desktop/main/',
  'pkg/sulla-desktop/backend/',
  'pkg/sulla-desktop/window/',
  'pkg/sulla-desktop/pages/',
] as const;

/**
 * Inputs proven type-only or elided that esbuild still reports. Each entry must say why.
 * esbuild only reports modules whose bindings survive into the bundle, so this starts empty.
 */
export const TYPE_ONLY_ALLOWLIST: Readonly<Record<string, string>> = {};

export interface ToolsLoadedModuleGraphOptions {
  /** Repo root that the Dockerfile COPY sources and tsconfig paths are relative to. */
  root: string;
  /** Full text of services/sulla-tools/Dockerfile. */
  dockerfile: string;
  /** Repo-relative entry files the Tools image runs (service entrypoints plus catalog loaders). */
  entrypoints: string[];
  /** Repo-relative tsconfig whose `paths` the bundle resolves with. Defaults to the root tsconfig. */
  tsconfig?: string;
}

interface OverrideCopy { destination: string; source: string }

export class ToolsLoadedModuleGraph {
  private readonly root: string;
  private readonly entrypoints: string[];
  private readonly tsconfig: string;
  private readonly overrides: OverrideCopy[];
  private readonly pathPatterns: RegExp[];
  private metafile?: Metafile;

  constructor(options: ToolsLoadedModuleGraphOptions) {
    this.root = options.root;
    this.entrypoints = [...options.entrypoints];
    this.tsconfig = options.tsconfig ?? 'tsconfig.json';
    this.overrides = ToolsLoadedModuleGraph.parseOverrides(options.dockerfile);
    this.pathPatterns = this.readPathPatterns();
  }

  /** Every repo-relative file esbuild bundles from the entrypoints (node builtins and packages excluded). */
  async loadedInputs(): Promise<string[]> {
    const metafile = await this.analyse();
    return Object.keys(metafile.inputs).sort();
  }

  /** Loaded inputs under the Desktop trees the Tools image never copies. Each one is a load-time crash. */
  async sensitiveInputs(): Promise<string[]> {
    return (await this.loadedInputs()).filter(input => this.isSensitive(input));
  }

  /** Sensitive inputs that are not explained by the allowlist. Empty means the image loads no such module. */
  async violations(): Promise<string[]> {
    return (await this.sensitiveInputs()).filter(input => !(input in TYPE_ONLY_ALLOWLIST));
  }

  /** Shortest load chain from an entrypoint to `input` (inclusive), or [] when the input is not loaded. */
  async loadChain(input: string): Promise<string[]> {
    const metafile = await this.analyse();
    const parents = new Map<string, string | undefined>();
    const queue: string[] = [];
    for (const entry of this.entrypoints) {
      if (!parents.has(entry)) { parents.set(entry, undefined); queue.push(entry); }
    }
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (current === input) break;
      for (const imported of metafile.inputs[current]?.imports ?? []) {
        if (!parents.has(imported.path) && imported.path in metafile.inputs) {
          parents.set(imported.path, current);
          queue.push(imported.path);
        }
      }
    }
    if (!parents.has(input)) return [];
    const chain: string[] = [];
    for (let node: string | undefined = input; node !== undefined; node = parents.get(node)) chain.unshift(node);
    return chain;
  }

  /** `importer -> imported` edges for sensitive inputs, read from esbuild's metafile. */
  async sensitiveEdges(): Promise<string[]> {
    const metafile = await this.analyse();
    const edges = new Set<string>();
    for (const [importer, meta] of Object.entries(metafile.inputs)) {
      for (const imported of meta.imports) {
        if (this.isSensitive(imported.path)) edges.add(`${ importer } -> ${ imported.path }`);
      }
    }
    return [...edges].sort();
  }

  /** A Desktop-only input the image does not copy. Override destinations are copied (as the stub), so they are not. */
  private isSensitive(input: string): boolean {
    if (this.overrides.some(override => override.destination === input)) return false;
    return SENSITIVE_INPUT_PREFIXES.some(prefix => input.startsWith(prefix));
  }

  private async analyse(): Promise<Metafile> {
    if (this.metafile) return this.metafile;
    const esbuild = await import('esbuild');
    const options: BuildOptions = {
      absWorkingDir: this.root,
      entryPoints:   this.entrypoints.map(entry => path.join(this.root, entry)),
      bundle:        true,
      platform:      'node',
      format:        'esm',
      target:        'node22',
      tsconfig:      path.join(this.root, this.tsconfig),
      metafile:      true,
      write:         false,
      outdir:        path.join(this.root, '.tools-loaded-module-graph'),
      logLevel:      'silent',
      plugins:       [this.plugin()],
    };
    const result = await esbuild.build(options);
    this.metafile = result.metafile;
    return result.metafile;
  }

  private plugin(): Plugin {
    const overrides = this.overrides;
    const root = this.root;
    const pathPatterns = this.pathPatterns;
    return {
      name: 'tools-loaded-module-graph',
      setup(build) {
        // Manifest loaders (`loader: () => import('./x')`) run only for catalog-target entries, and those
        // files are roots (ToolManifestEntrypoints). Every other manifest import() stays unloaded in the image.
        build.onResolve({ filter: /.*/ }, args => {
          if (args.kind !== 'dynamic-import' || !MANIFEST_IMPORTER.test(args.importer)) return undefined;
          return { path: args.path, external: true };
        });
        // Bare specifiers that the tsconfig does not map are npm packages or node builtins. They are not
        // Desktop source, and they are installed in the image's node_modules, so they stay external.
        build.onResolve({ filter: /^[^./]/ }, args => {
          if (pathPatterns.some(pattern => pattern.test(args.path))) return undefined;
          return { path: args.path, external: true };
        });
        // The image runs the override source at the destination path. Load that text, keep the destination identity.
        for (const { destination, source } of overrides) {
          const filter = new RegExp(`${ escapeRegExp(path.join(root, destination)) }$`);
          build.onLoad({ filter }, () => ({
            contents:   readFileSync(path.join(root, source), 'utf8'),
            loader:     'ts',
            resolveDir: path.dirname(path.join(root, destination)),
          }));
        }
      },
    };
  }

  private readPathPatterns(): RegExp[] {
    const configPath = path.join(this.root, this.tsconfig);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) throw new Error(`Cannot read ${ this.tsconfig }: ${ ts.flattenDiagnosticMessageText(read.error.messageText, '\n') }`);
    const paths = (read.config?.compilerOptions?.paths ?? {}) as Record<string, string[]>;
    return Object.keys(paths).map(key => new RegExp(`^${ key.split('*').map(escapeRegExp).join('.*') }$`));
  }

  /** Override COPYs: a `.ts` source copied onto a `.ts` destination replaces that file in the image. */
  private static parseOverrides(dockerfile: string): OverrideCopy[] {
    const overrides: OverrideCopy[] = [];
    for (const line of dockerfile.split(/\r?\n/)) {
      const copy = /^COPY\s+(\S+)\s+(\S+)\s*$/.exec(line);
      if (!copy || copy[1].startsWith('--')) continue;
      const [, source, destination] = copy;
      if (/\.tsx?$/.test(source) && /\.tsx?$/.test(destination)) {
        overrides.push({ destination: path.posix.normalize(destination), source });
      }
    }
    return overrides;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
