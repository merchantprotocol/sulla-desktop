#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Architecture guard (Sulla OOP rebuild, ARCHITECTURE-PLAN §5 phase 0 and §10 item 4).
// Zero dependencies: plain Node 18+, regex/line based, runs in seconds.
//
// Fails when production (non-test) code gains:
//   mutable-state    top-level `let`/`var`, or a module-scope Map/Set/array/object that is mutated
//   raw-sql          raw SQL strings / sql`` tags / db client calls outside repository, model or migration folders
//   long-file        a file over the line limit (default 400) that is not on the allowlist
//   procedural-module a file that exports free functions doing I/O or business logic and no class,
//                    that is not on the allowlist
//
// Today's offenders live in architecture-guard.allowlist.json. The allowlist may only shrink:
//   - a file's recorded count for mutable-state / raw-sql may not go up
//   - a new file may not be added to the allowlist (checked against the PR base branch)
//
// Usage:
//   node scripts/architecture-guard/guard.mjs            check (CI)
//   node scripts/architecture-guard/guard.mjs --prune    remove fixed entries / lower counts (never adds)
//   node scripts/architecture-guard/guard.mjs --init     write the allowlist from today's code (first setup only)
//   env GUARD_BASE_REF=origin/main                       compare allowlist growth against this ref

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'architecture-guard.config.json');
const ALLOWLIST_NAME = 'architecture-guard.allowlist.json';
const ALLOWLIST_PATH = path.join(ROOT, ALLOWLIST_NAME);
const RULES = ['mutable-state', 'raw-sql', 'long-file', 'procedural-module'];

const DEFAULT_CONFIG = {
  maxLines: 400,
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
  // Paths (regex, matched against the repo-relative POSIX path) that are never scanned.
  ignore: [
    '(^|/)node_modules/', '(^|/)dist/', '(^|/)build/', '(^|/)out/', '(^|/)coverage/', '(^|/)vendor/',
    '(^|/)\\.', '\\.d\\.ts$', '\\.min\\.js$', '(^|/)generated/',
    // tests are not production code
    '\\.(test|spec)\\.[cm]?[jt]sx?$', '(^|/)__tests__/', '(^|/)__mocks__/', '(^|/)__fixtures__/',
    '(^|/)tests?/', '(^|/)e2e/', '(^|/)fixtures/',
  ],
  // Folders where raw SQL / db client calls are allowed.
  sqlAllowed: ['(^|/)[Rr]epositor(y|ies)/', '(^|/)[Mm]odels?/', '(^|/)migrations/', '(^|/)database/migrations/', '\\.sql$'],
  // Paths exempt from the procedural-module rule (UI components, configs, CLI scripts).
  proceduralExempt: ['\\.(vue|tsx|jsx)$', '(^|/)[^/]*\\.config\\.[cm]?[jt]s$', '(^|/)scripts/'],
  // Paths exempt from the mutable-state rule (Vue SFC <script setup> state is per instance).
  mutableStateExempt: ['\\.vue$'],
};

function loadConfig() {
  const user = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const cfg = { ...DEFAULT_CONFIG, ...user };
  for (const key of ['ignore', 'sqlAllowed', 'proceduralExempt', 'mutableStateExempt']) {
    // `key` replaces the default list; `extra_<key>` appends to it.
    cfg[key] = [...(user[key] || DEFAULT_CONFIG[key]), ...(user[`extra_${key}`] || [])];
    cfg[`${key}Re`] = cfg[key].map((p) => new RegExp(p));
  }
  return cfg;
}

function listFiles(cfg) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean)
    .filter((f) => cfg.extensions.includes(path.extname(f)))
    .filter((f) => !cfg.ignoreRe.some((re) => re.test(f)))
    .filter((f) => existsSync(path.join(ROOT, f)));
}

// Blank out comments and string/template contents (keeping line structure) so code patterns
// don't match inside text. Returns { code, strings } where strings are the literal contents.
function stripCommentsAndStrings(src) {
  let code = '';
  const strings = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') code += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let s = '';
      code += q;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break; // unterminated
        if (src[i] === '\n') code += '\n';
        s += src[i];
        i++;
      }
      strings.push({ quote: q, text: s, tagged: q === '`' ? /\bsql\s*$/.test(code.slice(0, -1)) : false });
      code += q;
      i++;
      continue;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

function vueScript(src) {
  const m = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  return m.map((x) => x[1]).join('\n');
}

const SQL_RE = /^\s*(SELECT\s[\s\S]*?\sFROM\s|INSERT\s+INTO\s|UPDATE\s+["`\w.]+\s+SET\s|DELETE\s+FROM\s|CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\s|ALTER\s+TABLE\s|DROP\s+TABLE\s|WITH\s+\w+\s+AS\s*\()/;
const DB_CALL_RE = /\b(?:db|DB|pool|client|conn|connection|pg|sql|database|d1|D1|knex)\s*\.\s*(?:query|prepare|exec|execute|batch|run|all|get|raw)\s*\(/g;
const IO_RE = /\b(await|fetch\s*\(|readFile|writeFile|fs\.|fsp\.|ipcMain|ipcRenderer|child_process|spawn\s*\(|exec\s*\(|\.prepare\s*\(|\.query\s*\(|localStorage|AsyncStorage|SecureStore|indexedDB|new\s+WebSocket|XMLHttpRequest|env\.[A-Z_]+\.)/;

function analyze(file, cfg) {
  let src = readFileSync(path.join(ROOT, file), 'utf8');
  const lines = src.split('\n').length;
  if (file.endsWith('.vue')) src = vueScript(src);
  const { code, strings } = stripCommentsAndStrings(src);
  const found = {};

  // long-file (whole file, template included)
  if (lines > cfg.maxLines) found['long-file'] = lines;

  // mutable-state
  if (!cfg.mutableStateExemptRe.some((re) => re.test(file))) {
    let count = 0;
    const codeLines = code.split('\n');
    for (const line of codeLines) {
      if (/^(export\s+)?(let|var)\s+[\w${[]/.test(line)) count++;
    }
    const constRe = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b|\[|\{)/gm;
    for (const m of code.matchAll(constRe)) {
      if (/^new\s+(Map|Set|WeakMap|WeakSet)\b/.test(m[2])) { count++; continue; } // these exist to be mutated
      const name = m[1].replace(/\$/g, '\\$');
      const mut = new RegExp(`\\b${name}\\s*(?:\\.\\s*(?:set|add|push|delete|clear|splice|pop|shift|unshift|sort|reverse|fill)\\s*\\(|\\[[^\\]\\n]+\\]\\s*(?:=(?!=)|\\+=|-=|\\+\\+|--)|\\.[A-Za-z_$][\\w$]*\\s*(?:=(?!=)|\\+=|-=|\\+\\+|--))|delete\\s+${name}\\b`);
      if (mut.test(code)) count++;
    }
    if (count) found['mutable-state'] = count;
  }

  // raw-sql
  if (!cfg.sqlAllowedRe.some((re) => re.test(file))) {
    let count = 0;
    for (const s of strings) if (s.tagged || SQL_RE.test(s.text)) count++;
    count += [...code.matchAll(DB_CALL_RE)].length;
    if (count) found['raw-sql'] = count;
  }

  // procedural-module
  if (!cfg.proceduralExemptRe.some((re) => re.test(file))) {
    const exportsClass = /^export\s+(default\s+)?(abstract\s+)?class\s/m.test(code);
    const fnExports = (code.match(/^export\s+(default\s+)?(async\s+)?function\b|^export\s+const\s+[\w$]+\s*(?::[^=\n]+)?=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:[^=\n]+)?=>|^export\s+const\s+[\w$]+\s*=\s*(async\s+)?function\b/gm) || []).length;
    if (!exportsClass && fnExports > 0 && IO_RE.test(code)) found['procedural-module'] = fnExports;
  }
  return found;
}

function readAllowlist(text) {
  const data = text ? JSON.parse(text) : { files: {} };
  return data.files || {};
}

function baseAllowlist() {
  const ref = process.env.GUARD_BASE_REF;
  if (!ref) return null;
  try {
    return readAllowlist(execFileSync('git', ['show', `${ref}:${ALLOWLIST_NAME}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch {
    return null; // allowlist does not exist on base yet (first PR)
  }
}

function writeAllowlist(files) {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  const total = Object.values(sorted).reduce((a, e) => a + Object.keys(e.rules).length, 0);
  const doc = {
    about: 'Architecture guard allowlist. Today\'s offenders only. It may only shrink: never add files or raise counts. See ARCHITECTURE-GUARD.md.',
    entries: total,
    files: sorted,
  };
  writeFileSync(ALLOWLIST_PATH, JSON.stringify(doc, null, 2) + '\n');
  return total;
}

const REASON = {
  'mutable-state': 'pre-existing module-level mutable state; move into a class instance bound in a ServiceProvider',
  'raw-sql': 'pre-existing raw SQL outside a repository; move into app/Repositories',
  'long-file': 'pre-existing file over the line limit; split into classes',
  'procedural-module': 'pre-existing procedural module; convert to a Service/Repository class',
};

function main() {
  const t0 = Date.now();
  const cfg = loadConfig();
  const mode = process.argv.includes('--init') ? 'init' : process.argv.includes('--prune') ? 'prune' : 'check';
  const files = listFiles(cfg);
  const results = {};
  for (const f of files) {
    const r = analyze(f, cfg);
    if (Object.keys(r).length) results[f] = r;
  }

  if (mode === 'init') {
    const out = {};
    for (const [f, r] of Object.entries(results)) {
      out[f] = { rules: r, reason: Object.keys(r).map((k) => REASON[k]).join('; ') };
    }
    const total = writeAllowlist(out);
    console.log(`architecture-guard: wrote ${ALLOWLIST_NAME} with ${Object.keys(out).length} files / ${total} rule entries (${files.length} files scanned, ${Date.now() - t0} ms)`);
    return;
  }

  const allow = readAllowlist(existsSync(ALLOWLIST_PATH) ? readFileSync(ALLOWLIST_PATH, 'utf8') : '');
  const errors = [];
  const stale = [];

  for (const [f, r] of Object.entries(results)) {
    for (const [rule, value] of Object.entries(r)) {
      const entry = allow[f]?.rules?.[rule];
      if (entry === undefined) {
        const what = {
          'mutable-state': `${value} top-level mutable declaration(s) (top-level let/var or a module-scope Map/Set/array/object that is mutated). Put state in a class instance.`,
          'raw-sql': `${value} raw SQL string(s) / db client call(s) outside a repository/model/migration folder. Move data access into a Repository.`,
          'long-file': `${value} lines (limit ${cfg.maxLines}). Split it into classes.`,
          'procedural-module': `exports ${value} free function(s) doing I/O/business logic and no class. Make it a Service/Repository class.`,
        }[rule];
        errors.push(`${f}: [${rule}] ${what}`);
      } else if (rule !== 'long-file' && rule !== 'procedural-module' && value > entry) {
        errors.push(`${f}: [${rule}] count rose from ${entry} to ${value}. Allowlisted files may not gain more of this.`);
      } else if (rule !== 'long-file' && rule !== 'procedural-module' && value < entry) {
        stale.push(`${f}: [${rule}] now ${value}, allowlist says ${entry}`);
      } else if (rule === 'long-file' && value > entry) {
        console.warn(`warning: ${f} grew from ${entry} to ${value} lines (allowlisted long file; please split rather than grow)`);
      }
    }
  }
  for (const [f, e] of Object.entries(allow)) {
    for (const rule of Object.keys(e.rules || {})) {
      if (!results[f] || results[f][rule] === undefined) stale.push(`${f}: [${rule}] fixed or file removed`);
    }
  }

  if (mode === 'prune') {
    const next = {};
    for (const [f, e] of Object.entries(allow)) {
      const rules = {};
      for (const [rule, v] of Object.entries(e.rules || {})) {
        const now = results[f]?.[rule];
        if (now === undefined) continue;
        rules[rule] = rule === 'long-file' || rule === 'procedural-module' ? v : Math.min(v, now);
      }
      if (Object.keys(rules).length) next[f] = { ...e, rules };
    }
    const total = writeAllowlist(next);
    console.log(`architecture-guard: pruned allowlist to ${Object.keys(next).length} files / ${total} entries`);
    return;
  }

  // Allowlist may only shrink relative to the PR base.
  const base = baseAllowlist();
  if (base) {
    for (const [f, e] of Object.entries(allow)) {
      for (const [rule, v] of Object.entries(e.rules || {})) {
        const b = base[f]?.rules?.[rule];
        if (b === undefined) errors.push(`${ALLOWLIST_NAME}: new entry ${f} [${rule}] — the allowlist may only shrink. Fix the code instead.`);
        else if ((rule === 'mutable-state' || rule === 'raw-sql') && v > b) errors.push(`${ALLOWLIST_NAME}: ${f} [${rule}] raised from ${b} to ${v} — the allowlist may only shrink.`);
      }
    }
  }

  const entries = Object.values(allow).reduce((a, e) => a + Object.keys(e.rules || {}).length, 0);
  if (stale.length) {
    console.error(`\nThe allowlist has entries that are already fixed. Run \`node scripts/architecture-guard/guard.mjs --prune\` and commit ${ALLOWLIST_NAME}:`);
    for (const s of stale) console.error(`  - ${s}`);
  }
  if (errors.length) {
    console.error(`\narchitecture-guard: FAILED (${errors.length} problem(s)). See ARCHITECTURE-GUARD.md.`);
    for (const e of errors) console.error(`  ✗ ${e}`);
  }
  console.log(`\narchitecture-guard: scanned ${files.length} files in ${Date.now() - t0} ms; allowlist ${Object.keys(allow).length} files / ${entries} entries${base ? ' (compared with base)' : ''}.`);
  if (errors.length || stale.length) process.exit(1);
  console.log('architecture-guard: OK');
}

main();
