import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** Resolves module specifiers to repo-relative files under one root. Test support only. */
export class ModuleFiles {
  constructor(private readonly root: string) {}

  /** Repo-relative file a specifier points at, or undefined for packages and missing targets. */
  resolve(fromFile: string, specifier: string): string | undefined {
    if (specifier.startsWith('@pkg/')) return this.firstFile(`pkg/sulla-desktop/${ specifier.slice('@pkg/'.length) }`);
    if (!specifier.startsWith('.')) return undefined;
    return this.firstFile(path.posix.join(path.posix.dirname(fromFile), specifier));
  }

  private firstFile(base: string): string | undefined {
    const target = path.posix.normalize(base).replace(/\.(?:js|mjs|cjs|ts|tsx)$/, '');
    return [target, `${ target }.ts`, `${ target }.tsx`, `${ target }.js`, `${ target }/index.ts`]
      .find(candidate => this.isFile(candidate));
  }

  private isFile(relativePath: string): boolean {
    const absolute = path.join(this.root, relativePath);
    return existsSync(absolute) && statSync(absolute).isFile();
  }
}
