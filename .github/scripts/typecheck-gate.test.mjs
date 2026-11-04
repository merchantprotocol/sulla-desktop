// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubAnnotationReporter, TypeScriptDiagnostic } from './typecheck-gate.mjs';

test('reports only supplied new diagnostics as annotations and a step summary', () => {
  // risk: CI failures become unactionable when new diagnostics are hidden by baseline annotations.
  const commands = [];
  const summaries = [];
  const reporter = new GitHubAnnotationReporter({
    githubActions: true,
    summaryPath: '/github/step-summary.md',
    commandWriter: (value) => commands.push(value),
    summaryAppender: (path, value) => summaries.push([path, value]),
  });
  const diagnostics = [
    new TypeScriptDiagnostic('agent/services/Rate%Limiter.ts', 17, 'TS2322', 'bad 100% value\r\nuse a string'),
  ];

  reporter.beforeTypecheck();
  reporter.report('tsconfig.agent.json', diagnostics, ['agent/old.ts\tTS2307\tmissing module']);

  assert.deepEqual(commands, [
    '::remove-matcher owner=tsc::\n',
    '::error file=agent/services/Rate%25Limiter.ts,line=17,title=typecheck-gate new error TS2322::bad 100%25 value%0D%0Ause a string\n',
  ]);
  assert.deepEqual(summaries, [[
    '/github/step-summary.md',
    '## Typecheck gate: `tsconfig.agent.json`\n\n**New TypeScript errors: 1**\n\n- `agent/services/Rate%Limiter.ts:17 TS2322` bad 100% value\r\nuse a string\n\n**Stale baseline fingerprints: 1**\n\n- `agent/old.ts\tTS2307\tmissing module`\n\n',
  ]]);
});
