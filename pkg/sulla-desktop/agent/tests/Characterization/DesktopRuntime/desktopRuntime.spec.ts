// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = process.cwd();

function copiedRoots(dockerfile: string): string[] {
  return dockerfile.split('\n').map(line => line.match(/^COPY\s+([^\s]+)\s+/)?.[1]).filter((x): x is string => Boolean(x));
}
function covered(file: string, copies: string[]): boolean {
  const rel = path.relative(root, file).replaceAll(path.sep, '/');
  return copies.some(copy => rel === copy || rel.startsWith(`${copy.replace(/\/$/, '')}/`));
}
function resolveWorkspaceImport(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith('@pkg/') ? path.join(root, 'pkg/sulla-desktop', specifier.slice(5))
    : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : undefined;
  if (!base) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    try { if (ts.sys.fileExists(candidate)) return candidate } catch {}
  }
  return undefined;
}
async function importClosure(entries: string[]): Promise<Set<string>> {
  const seen = new Set<string>(); const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveWorkspaceImport(file, node.moduleSpecifier.text); if (resolved) queue.push(resolved);
      }
    }
  }
  return seen;
}

describe('desktop runtime regression contracts', () => {
  it('BL-045 copies every workspace module in the sulla_tools static-import closure', async () => {
    const dockerfile = await readFile(path.join(root, 'services/sulla-tools/Dockerfile'), 'utf8');
    const closure = await importClosure([path.join(root, 'services/sulla-tools/src/index.ts')]);
    const missing = [...closure].filter(file => !covered(file, copiedRoots(dockerfile))).map(file => path.relative(root, file));
    expect(missing, `static imports absent from services/sulla-tools/Dockerfile COPY:\n${missing.join('\n')}`).toEqual([]);
  });

  // SPEC-FINDING SF-2c-30: production normalizes BusyBox's full record without weakening the mkfs guard.
  it('BL-047 BusyBox blkid distinguishes a formatted ext4 image from a blank disk before mkfs', async (context) => {
    try { await exec('go', ['test', './src/runtime-agent', '-run', '^TestFilesystemProbeNormalizesBlkidOutput$'], { cwd: root }) }
    catch (error: any) {
      if (error.code === 'ENOENT') { context.skip(); return }
      throw error;
    }
  }, 60_000);
});
