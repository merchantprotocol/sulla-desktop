// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Vendors Sulla Cloud's frontend (merchantprotocol/www-sulladesktop) into the Sulla Server console.
//
//   node scripts/sync-cloud-console.mjs --repo <www-sulladesktop checkout> [--ref <sha>] [--check | --dry-run]
//
// It takes the allowlisted files at a pinned commit, applies resources/sulla-console/patches/*.patch
// in order (three-way merges are reported, conflicts fail), copies the result into
// resources/sulla-console/public/ and builds the Passwords vault origin into
// services/sulla-vault/browser-dist/ with Cloud's own build-vault-origin.mjs.
//
//   (default)   write the vendored files and record their hashes in cloud-vendor.json
//   --check     rebuild in a temp dir and exit 1, naming each file, if the tree differs
//   --dry-run   only apply the patches (e.g. --ref origin/main to test a pin bump) and report
//
// Files under public/server/ and the other consoleOwned paths are the console's own and are never
// touched. The vault build needs esbuild: --esbuild <dir>, $SULLA_ESBUILD, or the one sulla-vault
// depends on. --no-vault skips it.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consoleDir = path.join(root, 'resources/sulla-console');
const manifestPath = path.join(consoleDir, 'cloud-vendor.json');
const patchDir = path.join(consoleDir, 'patches');
const publicDir = path.join(consoleDir, 'public');

function parseArgs(argv) {
  const args = { check: false, dryRun: false, vault: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-vault') args.vault = false;
    else if (['--repo', '--ref', '--esbuild'].includes(a)) args[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.repo) throw new Error('--repo <path to a www-sulladesktop checkout> is required');
  return args;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

// Runs git from inside the private work tree; `git apply` resolves paths against the cwd.
function treeGit(env, args, opts = {}) {
  return execFileSync('git', args, { cwd: env.GIT_WORK_TREE, env, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

function globToRegExp(pattern) {
  if (pattern.endsWith('/')) return new RegExp(`^${escapeRe(pattern)}`);
  return new RegExp(`^${pattern.split('*').map(escapeRe).join('[^/]*')}$`);
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// www path -> path under resources/sulla-console/public/
function consolePath(wwwPath) {
  return wwwPath.startsWith('cloud/') ? wwwPath.slice('cloud/'.length) : wwwPath;
}

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function hashTree(dir) {
  return Object.fromEntries(walk(dir).map((rel) => [rel, sha256(readFileSync(path.join(dir, rel)))]));
}

// Check out the allowlisted files at `ref` into a private index + work tree that share the www
// object database, so `git apply --3way` can find the patches' base blobs.
function checkoutAllowlist(repo, ref, manifest, work) {
  const include = manifest.include.map(globToRegExp);
  const exclude = manifest.exclude.map(globToRegExp);
  const env = {
    ...process.env,
    GIT_DIR: git(repo, ['rev-parse', '--absolute-git-dir']).trim(),
    GIT_INDEX_FILE: path.join(work, 'index'),
    GIT_WORK_TREE: path.join(work, 'tree'),
  };
  const entries = git(repo, ['ls-tree', '-r', '--full-tree', ref])
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const file = line.split('\t')[1];
      return include.some((re) => re.test(file)) && !exclude.some((re) => re.test(file));
    });
  if (!entries.length) throw new Error(`No allowlisted files at ${ref}`);
  mkdirSync(env.GIT_WORK_TREE, { recursive: true });
  treeGit(env, ['update-index', '--index-info'], { input: `${entries.join('\n')}\n` });
  treeGit(env, ['checkout-index', '--all', '--force']);
  treeGit(env, ['update-index', '--refresh', '-q']);
  return env;
}

function applyPatches(env) {
  const results = [];
  for (const name of readdirSync(patchDir).filter((f) => f.endsWith('.patch')).sort()) {
    const file = path.join(patchDir, name);
    const run = (args) => {
      const r = spawnSync('git', ['apply', ...args, file], { cwd: env.GIT_WORK_TREE, env, encoding: 'utf8' });
      return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
    };
    if (run(['--check', '--index']).ok) {
      const applied = run(['--index']);
      if (!applied.ok) throw new Error(`${name} failed to apply:\n${applied.out}`);
      results.push({ name, mode: 'clean' });
      continue;
    }
    const merged = run(['--3way']);
    const conflicted = treeGit(env, ['diff', '--name-only', '--diff-filter=U']).trim();
    if (!merged.ok || conflicted) {
      const detail = conflicted ? `Conflicts: ${conflicted}\n` : '';
      throw new Error(`${name} does not apply, even with a three-way merge.\n${merged.out}${detail}`);
    }
    const files = [...merged.out.matchAll(/Applied patch to '([^']+)' cleanly/g)].map((m) => m[1]);
    results.push({ name, mode: 'three-way', files });
  }
  return results;
}

function resolveEsbuild(explicit) {
  const candidates = [explicit, process.env.SULLA_ESBUILD].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'package.json'))) return path.resolve(dir);
  }
  for (const from of ['services/sulla-vault/package.json', 'package.json']) {
    try {
      const pkg = createRequire(path.join(root, from)).resolve('esbuild/package.json');
      return path.dirname(pkg);
    } catch {
      // try the next one
    }
  }
  throw new Error('esbuild not found. Install sulla-vault dependencies, or pass --esbuild <dir> (or --no-vault).');
}

function buildVaultOrigin(tree, out, manifest, esbuildDir) {
  mkdirSync(path.join(tree, 'node_modules'), { recursive: true });
  symlinkSync(esbuildDir, path.join(tree, 'node_modules/esbuild'), 'dir');
  execFileSync(process.execPath, [
    path.join(tree, 'js/cloud/passwords/build-vault-origin.mjs'),
    '--out', out,
    '--dashboard-origin', manifest.vaultOrigin.dashboardUrl,
  ], { cwd: tree, stdio: ['ignore', 'ignore', 'inherit'] });
}

function compare(label, expected, actual) {
  const problems = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actual)) problems.push(`missing    ${label}/${file}`);
    else if (actual[file] !== hash) problems.push(`differs    ${label}/${file}`);
  }
  for (const file of Object.keys(actual)) {
    if (!(file in expected)) problems.push(`unexpected ${label}/${file}`);
  }
  return problems;
}

function writeTree(fromDir, toDir, files, previous) {
  for (const file of Object.keys(previous)) {
    if (!(file in files)) rmSync(path.join(toDir, file), { force: true });
  }
  for (const file of Object.keys(files)) {
    mkdirSync(path.dirname(path.join(toDir, file)), { recursive: true });
    writeFileSync(path.join(toDir, file), readFileSync(path.join(fromDir, file)));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const repo = path.resolve(args.repo);
  const ref = git(repo, ['rev-parse', '--verify', `${args.ref ?? manifest.ref}^{commit}`]).trim();
  const work = mkdtempSync(path.join(tmpdir(), 'sync-cloud-console-'));
  try {
    const env = checkoutAllowlist(repo, ref, manifest, work);
    const patches = applyPatches(env);
    console.log(`www-sulladesktop ${ref.slice(0, 12)}`);
    for (const p of patches) {
      console.log(`  ${p.name}  ${p.mode === 'clean' ? 'applied cleanly' : `three-way merged: ${p.files.join(', ')}`}`);
    }
    if (args.dryRun) return 0;

    // Stage the console layout.
    const staged = path.join(work, 'public');
    for (const file of walk(env.GIT_WORK_TREE)) {
      const dest = path.join(staged, consolePath(file));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(path.join(env.GIT_WORK_TREE, file)));
    }
    for (const file of manifest.buildOnly) rmSync(path.join(staged, consolePath(file)), { force: true });
    const files = hashTree(staged);

    let vaultFiles = null;
    let esbuildVersion = null;
    const vaultOut = path.join(root, manifest.vaultOrigin.out);
    if (args.vault) {
      const esbuildDir = resolveEsbuild(args.esbuild);
      esbuildVersion = JSON.parse(readFileSync(path.join(esbuildDir, 'package.json'), 'utf8')).version;
      if (args.check && esbuildVersion !== manifest.vaultOrigin.esbuild) {
        const pinned = manifest.vaultOrigin.esbuild;
        console.warn(`  vault origin not checked: esbuild ${esbuildVersion} here, ${pinned} in cloud-vendor.json`);
      } else {
        buildVaultOrigin(env.GIT_WORK_TREE, path.join(work, 'vault'), manifest, esbuildDir);
        vaultFiles = hashTree(path.join(work, 'vault'));
      }
    }

    const owned = manifest.consoleOwned.map(globToRegExp);
    const vendoredOnDisk = Object.entries(hashTree(publicDir)).filter(([f]) => !owned.some((re) => re.test(f)));
    const onDisk = Object.fromEntries(vendoredOnDisk);

    if (args.check) {
      const problems = [
        ...(ref === manifest.ref ? [] : [`cloud-vendor.json pins ${manifest.ref}, checked ${ref}`]),
        ...compare('resources/sulla-console/public', files, onDisk),
        ...compare('cloud-vendor.json files', files, manifest.files),
      ];
      if (vaultFiles) {
        problems.push(...compare(manifest.vaultOrigin.out, vaultFiles, hashTree(vaultOut)));
        problems.push(...compare('cloud-vendor.json vaultOrigin.files', vaultFiles, manifest.vaultOrigin.files));
      }
      if (problems.length) {
        console.error(`Vendored console files don't match upstream + patches:\n  ${problems.join('\n  ')}`);
        console.error('Run node scripts/sync-cloud-console.mjs --repo <www-sulladesktop> to re-vendor.');
        return 1;
      }
      const vaultNote = vaultFiles ? `, ${Object.keys(vaultFiles).length} vault-origin files match` : '';
      console.log(`  ${Object.keys(files).length} vendored files match${vaultNote}`);
      return 0;
    }

    writeTree(staged, publicDir, files, { ...onDisk, ...manifest.files });
    manifest.ref = ref;
    manifest.files = files;
    if (vaultFiles) {
      rmSync(vaultOut, { recursive: true, force: true });
      writeTree(path.join(work, 'vault'), vaultOut, vaultFiles, {});
      manifest.vaultOrigin.esbuild = esbuildVersion;
      manifest.vaultOrigin.files = vaultFiles;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const vaultNote = vaultFiles ? ` and ${Object.keys(vaultFiles).length} to ${manifest.vaultOrigin.out}` : '';
    console.log(`  wrote ${Object.keys(files).length} files to resources/sulla-console/public${vaultNote}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
