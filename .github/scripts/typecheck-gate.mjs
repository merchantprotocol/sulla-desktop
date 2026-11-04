#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Runs `yarn tsc` for one project graph and fails the step only on
// TypeScript diagnostics that are not already recorded in that graph's
// baseline file. This lets CI gate new regressions in a graph that still
// carries pre-existing errors on main, without silently skipping the
// check altogether.
//
// A diagnostic's fingerprint is `file\tTScode\tnormalized message` —
// deliberately WITHOUT line/column. Line numbers shift whenever an
// unrelated edit adds or removes a line above an existing error, which
// would make a line-keyed baseline flag unchanged errors as "new". The
// baseline instead stores, per fingerprint, how many instances of that
// exact (file, code, message) tsc reported. If a graph gains another
// occurrence of an already-baselined error in the same file (e.g. a
// second `Cannot find module 'x'` in a file that already had one), the
// count for that fingerprint goes up and the extra instance(s) fail the
// gate, even though no new fingerprint was introduced. Fixing a
// pre-existing error only ever lowers a count, which never fails the
// gate — a stale baseline entry just gets logged as a reminder to
// regenerate.
//
// Regenerate a baseline after intentionally accepting new pre-existing
// errors (e.g. widening a graph's include set):
//   node .github/scripts/typecheck-gate.mjs --project <tsconfig> \
//     --baseline <baseline-file> --write-baseline [-- <extra tsc args>]
// then commit the rewritten baseline file. In CI, run the `typecheck`
// job via `workflow_dispatch` with `write_baseline: true` on the branch
// whose baselines you want to refresh: it regenerates all three graphs'
// baselines from that ref's actual tsc output and commits them back to
// the same branch automatically (see .github/workflows/agent-tests.yml).

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export class TypeScriptDiagnostic {
  constructor(file, line, code, message) {
    this.file = file;
    this.line = line;
    this.code = code;
    this.message = message;
  }

  get fingerprint() {
    return `${this.file}\t${this.code}\t${this.message}`;
  }

  static normalizeMessage(message) {
    return message.trim().replace(/\s+/g, ' ');
  }

  static parse(rawLine) {
    const match = rawLine.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/);
    if (!match) return null;
    const [, file, line, code, message] = match;
    return new TypeScriptDiagnostic(file, Number(line), code, TypeScriptDiagnostic.normalizeMessage(message));
  }
}

export class GitHubAnnotationReporter {
  constructor({ githubActions, summaryPath, commandWriter = (value) => process.stdout.write(value), summaryAppender = appendFileSync }) {
    this.githubActions = githubActions;
    this.summaryPath = summaryPath;
    this.commandWriter = commandWriter;
    this.summaryAppender = summaryAppender;
  }

  beforeTypecheck() {
    if (this.githubActions) this.commandWriter('::remove-matcher owner=tsc::\n');
  }

  report(project, diagnostics, staleFingerprints) {
    if (this.githubActions) {
      for (const diagnostic of diagnostics) this.commandWriter(`${this.annotationFor(diagnostic)}\n`);
    }
    if (this.summaryPath) this.summaryAppender(this.summaryPath, this.summaryFor(project, diagnostics, staleFingerprints));
  }

  annotationFor(diagnostic) {
    const title = `typecheck-gate new error ${diagnostic.code}`;
    return `::error file=${this.escapeProperty(diagnostic.file)},line=${diagnostic.line},title=${this.escapeProperty(title)}::${this.escapeData(diagnostic.message)}`;
  }

  summaryFor(project, diagnostics, staleFingerprints) {
    const lines = [
      `## Typecheck gate: \`${project}\``,
      '',
      `**New TypeScript errors: ${diagnostics.length}**`,
    ];
    if (diagnostics.length === 0) lines.push('', '- None');
    else lines.push('', ...diagnostics.map((diagnostic) => `- \`${diagnostic.file}:${diagnostic.line} ${diagnostic.code}\` ${diagnostic.message}`));
    lines.push('', `**Stale baseline fingerprints: ${staleFingerprints.length}**`);
    if (staleFingerprints.length === 0) lines.push('', '- None');
    else lines.push('', ...staleFingerprints.map((fingerprint) => `- \`${fingerprint}\``));
    return `${lines.join('\n')}\n\n`;
  }

  escapeData(value) {
    return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  }

  escapeProperty(value) {
    return this.escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
  }
}

class DiagnosticBaseline {
  constructor(counts) {
    this.counts = counts; // Map<fingerprint, number>
  }

  static empty() {
    return new DiagnosticBaseline(new Map());
  }

  static readFrom(path) {
    if (!existsSync(path)) return DiagnosticBaseline.empty();
    const counts = new Map();
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const tabIndex = line.indexOf('\t');
      const count = Number(line.slice(0, tabIndex));
      const fingerprint = line.slice(tabIndex + 1);
      counts.set(fingerprint, count);
    }
    return new DiagnosticBaseline(counts);
  }

  countFor(fingerprint) {
    return this.counts.get(fingerprint) ?? 0;
  }

  staleFingerprints(currentCounts) {
    return [...this.counts.keys()].filter((fingerprint) => !currentCounts.has(fingerprint));
  }

  static serialize(currentCounts) {
    const lines = [...currentCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fingerprint, count]) => `${count}\t${fingerprint}`);
    return lines.length ? `${lines.join('\n')}\n` : '';
  }
}

class TypecheckBaselineGate {
  constructor({ project, baselinePath, extraArgs, writeBaseline, reporter }) {
    this.project = project;
    this.baselinePath = baselinePath;
    this.extraArgs = extraArgs;
    this.writeBaseline = writeBaseline;
    this.reporter = reporter;
  }

  runTsc() {
    const args = ['tsc', '--project', this.project, ...this.extraArgs];
    return spawnSync('yarn', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    });
  }

  run() {
    this.reporter.beforeTypecheck();
    const result = this.runTsc();
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);

    const diagnostics = output
      .split('\n')
      .map((line) => TypeScriptDiagnostic.parse(line))
      .filter(Boolean);

    const currentCounts = new Map();
    const instancesByFingerprint = new Map();
    for (const diagnostic of diagnostics) {
      currentCounts.set(diagnostic.fingerprint, (currentCounts.get(diagnostic.fingerprint) ?? 0) + 1);
      if (!instancesByFingerprint.has(diagnostic.fingerprint)) instancesByFingerprint.set(diagnostic.fingerprint, []);
      instancesByFingerprint.get(diagnostic.fingerprint).push(diagnostic);
    }

    if (this.writeBaseline) {
      if (result.status !== 0 && diagnostics.length === 0) {
        console.error(
          `typecheck-gate: yarn tsc --project ${this.project} exited ${result.status} with no parsed diagnostics — refusing to write an empty baseline.`,
        );
        return result.status ?? 1;
      }
      writeFileSync(this.baselinePath, DiagnosticBaseline.serialize(currentCounts));
      console.log(
        `typecheck-gate: wrote ${currentCounts.size} baseline fingerprint(s) covering ${diagnostics.length} diagnostic instance(s) to ${this.baselinePath}`,
      );
      return 0;
    }

    const baseline = DiagnosticBaseline.readFrom(this.baselinePath);
    const newDiagnostics = [];
    for (const [fingerprint, count] of currentCounts) {
      const newCount = count - baseline.countFor(fingerprint);
      if (newCount <= 0) continue;
      const instances = instancesByFingerprint.get(fingerprint).sort((a, b) => a.line - b.line);
      for (const instance of instances.slice(-newCount)) {
        newDiagnostics.push(instance);
      }
    }

    const stale = baseline.staleFingerprints(currentCounts);
    const sortedNewDiagnostics = newDiagnostics.sort((a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code) || a.message.localeCompare(b.message),
    );
    this.reporter.report(this.project, sortedNewDiagnostics, stale);

    if (sortedNewDiagnostics.length > 0) {
      console.error(`\ntypecheck-gate: ${sortedNewDiagnostics.length} new TypeScript error(s) not in baseline ${this.baselinePath}:`);
      for (const diagnostic of sortedNewDiagnostics) {
        console.error(`  ${diagnostic.file}(${diagnostic.line}): ${diagnostic.code}: ${diagnostic.message}`);
      }
      return 1;
    }

    if (result.status !== 0 && diagnostics.length === 0) {
      console.error(`typecheck-gate: yarn tsc --project ${this.project} exited ${result.status} with no parsed diagnostics — treating as a hard failure.`);
      return result.status ?? 1;
    }

    if (diagnostics.length > 0) {
      console.log(`typecheck-gate: ${diagnostics.length} pre-existing error(s) remain within baseline for ${this.project} — no new errors.`);
    }

    if (stale.length > 0) {
      console.log(
        `typecheck-gate: ${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} now stale (fixed) for ${this.project} — regenerate the baseline when convenient.`,
      );
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const reporter = new GitHubAnnotationReporter({
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });
  const gate = new TypecheckBaselineGate({ ...options, reporter });
  process.exitCode = gate.run();
}
