/**
 * Which files in a local artifact folder go into a marketplace bundle.
 *
 * Shared by the zipper and the manifest builder so `manifest.bundle.files`
 * always matches the zip. Excludes secrets, VCS/OS junk, dependency and
 * cache directories, and the local install marker — publishing must never
 * upload a user's `.env`, `.git`, or `node_modules`.
 */
import * as fs from 'fs';
import * as path from 'path';

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', 'venv',
  '.pytest_cache', '.mypy_cache', '.idea', '.vscode',
]);

const EXCLUDED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.marketplace.json', '.npmrc', '.pypirc', '.netrc',
  'id_rsa', 'id_ed25519',
]);

export function isExcludedFromBundle(name: string, isDir: boolean): boolean {
  if (isDir) return EXCLUDED_DIRS.has(name);
  if (EXCLUDED_FILES.has(name)) return true;
  // .env, .env.local, .env.production … but keep documented templates.
  if (/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(name)) return true;

  return false;
}

/** Absolute paths of every publishable regular file under `root`. Symlinks are skipped. */
export function listBundleFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isExcludedFromBundle(entry.name, true)) stack.push(full);
      } else if (entry.isFile() && !isExcludedFromBundle(entry.name, false)) {
        out.push(full);
      }
    }
  }

  return out;
}
