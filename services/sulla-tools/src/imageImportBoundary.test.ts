import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

class ToolsImageImportBoundary {
  private readonly root = process.cwd();
  private readonly copiedRoots: string[];
  private readonly overrideTargets = new Set<string>();

  constructor() {
    const dockerfile = readFileSync(path.join(this.root, 'services/sulla-tools/Dockerfile'), 'utf8');
    this.copiedRoots = [];
    for (const line of dockerfile.split(/\r?\n/)) {
      const copy = /^COPY\s+(\S+)\s+(\S+)\s*$/.exec(line);
      if (!copy || copy[1].startsWith('--')) continue;
      const source = copy[1];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(copy[2]), path.posix.basename(source)));
      if (source === 'services/sulla-tools/src/pendingCredentials.container.ts') {
        this.overrideTargets.add('pkg/sulla-desktop/main/firstRun/pendingCredentials.ts');
      }
      if (existsSync(path.join(this.root, source)) && statSync(path.join(this.root, source)).isDirectory()) this.copiedRoots.push(path.posix.normalize(copy[2]));
      else if (source === 'package.json' || source === 'tsconfig.json') continue;
      else this.copiedRoots.push(target);
    }
  }

  private isCopied(file: string): boolean {
    const normalized = path.posix.normalize(file);
    return this.overrideTargets.has(normalized) || this.copiedRoots.some(root => normalized === root || normalized.startsWith(`${root}/`));
  }

  private resolve(from: string, specifier: string): string | undefined {
    let target = specifier.startsWith('@pkg/') ? `pkg/sulla-desktop/${specifier.slice(5)}` : path.posix.join(path.posix.dirname(from), specifier);
    if (!specifier.startsWith('.') && !specifier.startsWith('@pkg/')) return undefined;
    target = path.posix.normalize(target).replace(/\.(?:js|mjs|cjs|ts|tsx)$/, '');
    const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}/index.ts`];
    return candidates.find(candidate => existsSync(path.join(this.root, candidate)));
  }

  private runtimeImports(file: string): Array<{ specifier:string; typeOnly:boolean }> {
    const source = readFileSync(path.join(this.root, file), 'utf8');
    const imports: Array<{specifier:string;typeOnly:boolean}> = [];
    const pattern = /(?:import\s+(type\s+)?(?:[^'";]*?\s+from\s+)?|export\s+(?:type\s+)?[^'";]*?\s+from\s+|import\s*\()(['"])([^'"\n]+)\1/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) imports.push({specifier:match[3], typeOnly: Boolean(match[1]) || /^import\s+type\b/.test(match[0])});
    return imports;
  }

  private scan(entrypoints: string[]): string[] {
    const seen = new Set<string>();
    const violations = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const dependency of this.runtimeImports(file)) {
        if (dependency.typeOnly) continue;
        const resolved = this.resolve(file, dependency.specifier);
        if (!resolved) continue;
        if (!this.isCopied(resolved)) violations.add(`${file} -> ${resolved}`);
        else visit(resolved);
      }
    };
    entrypoints.forEach(visit);
    return [...violations].sort();
  }

  violations(): string[] {
    // The service executes only catalog-target tools locally. Other categories
    // are forwarded to Desktop and must not be imported/executed in this image.
    const roots = ['services/sulla-tools/src/index.ts', 'services/sulla-tools/src/catalog.ts'];
    const catalogCategories = ['files', 'pg', 'redis', 'project'];
    for (const category of catalogCategories) {
      const manifest = `pkg/sulla-desktop/agent/tools/${category}/manifests.ts`;
      const source = readFileSync(path.join(this.root, manifest), 'utf8');
      for (const line of source.split(/\r?\n/)) {
        const target = /executionTarget:\s*['\"]([^'\"]+)['\"]/.exec(line)?.[1];
        if (target && target !== 'catalog') continue;
        if (!target && category === 'files') continue; // files/request_publish is Desktop-only by executionTargetFor.
        const loader = /loader:\s*\(\)\s*=>\s*import\(['\"](\.\/[^'\"]+)['\"]\)/.exec(line)?.[1];
        if (loader) {
          const resolved = this.resolve(manifest, loader);
          if (resolved) roots.push(resolved);
        }
      }
    }
    return this.scan(roots);
  }
}

describe('sulla-tools image import boundary', () => {
  it('keeps runtime imports reachable from Tools entrypoints inside copied image paths', () => {
    const boundary = new ToolsImageImportBoundary();
    expect(boundary.violations()).toEqual([]);
  });
});
