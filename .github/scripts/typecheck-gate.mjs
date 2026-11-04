#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Runs `yarn tsc` for one project graph and fails the step only on
// TypeScript diagnostics that are not already recorded in that graph's
// baseline file. This lets CI gate new regressions in a graph that still
// carries pre-existing errors on main, without silently skipping the
// check altogether.
//
// Regenerate a baseline after intentionally accepting new pre-existing
// errors (e.g. widening a graph's include set):
//   node .github/scripts/typecheck-gate.mjs --project <tsconfig> \
//     --baseline <baseline-file> --write-baseline [-- <extra tsc args>]
// then commit the rewritten baseline file.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

class TypeScriptDiagnostic {
  constructor(file, line, code) {
    this.file = file;
    this.line = line;
    this.code = code;
  }

  get key() {
    return `${this.file}(${this.line}): ${this.code}`;
  }

  static parse(rawLine) {
    const match = rawLine.match(/^(.+?)\((\d+),\d+\): error (TS\d+):/);
    if (!match) return null;
    return new TypeScriptDiagnostic(match[1], Number(match[2]), match[3]);
  }
}

class TypecheckBaselineGate {
  constructor({ project, baselinePath, extraArgs, writeBaseline }) {
    this.project = project;
    this.baselinePath = baselinePath;
    this.extraArgs = extraArgs;
    this.writeBaseline = writeBaseline;
  }

  readBaseline() {
    if (!existsSync(this.baselinePath)) return new Set();
    return new Set(
      readFileSync(this.baselinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }

  runTsc() {
    const args = ['tsc', '--project', this.project, ...this.extraArgs];
    return spawnSync('yarn', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    });
  }

  run() {
    const result = this.runTsc();
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);

    const diagnostics = output
      .split('\n')
      .map((line) => TypeScriptDiagnostic.parse(line))
      .filter(Boolean);
    const current = new Set(diagnostics.map((diagnostic) => diagnostic.key));
    const baseline = this.readBaseline();
    const newErrors = [...current].filter((key) => !baseline.has(key));

    if (this.writeBaseline) {
      const body = [...current].sort().join('\n');
      writeFileSync(this.baselinePath, current.size ? `${body}\n` : '');
      console.log(`typecheck-gate: wrote ${current.size} baseline entries to ${this.baselinePath}`);
      return 0;
    }

    if (newErrors.length > 0) {
      console.error(`\ntypecheck-gate: ${newErrors.length} new TypeScript error(s) not in baseline ${this.baselinePath}:`);
      for (const key of newErrors.sort()) console.error(`  ${key}`);
      return 1;
    }

    if (result.status !== 0 && current.size === 0) {
      console.error(`typecheck-gate: yarn tsc --project ${this.project} exited ${result.status} with no parsed diagnostics — treating as a hard failure.`);
      return result.status ?? 1;
    }

    const carriedOver = current.size;
    if (carriedOver > 0) {
      console.log(`typecheck-gate: ${carriedOver} pre-existing error(s) remain within baseline for ${this.project} — no new errors.`);
    }
    return 0;
  }
}

function parseArgs(argv) {
  const options = { extraArgs: [], writeBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') options.project = argv[++i];
    else if (arg === '--baseline') options.baselinePath = argv[++i];
    else if (arg === '--write-baseline') options.writeBaseline = true;
    else if (arg === '--') options.extraArgs.push(...argv.slice(i + 1)), (i = argv.length);
    else options.extraArgs.push(arg);
  }
  if (!options.project || !options.baselinePath) {
    throw new Error('Usage: typecheck-gate.mjs --project <tsconfig> --baseline <file> [--write-baseline] [-- <extra tsc args>]');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const gate = new TypecheckBaselineGate(options);
process.exitCode = gate.run();
