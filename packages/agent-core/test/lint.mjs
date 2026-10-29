// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Lints src/ with the portability rules from eslint-rules.mjs (the same
// object the root eslint.config.mts uses). Runs without the repo's full
// dependency install: eslint and typescript-eslint load from
// AGENT_CORE_TOOLS_DIR, like the other runtime test tools. A probe file
// that breaks every rule must fail, so the check can't pass by linting
// nothing.

import { fileURLToPath } from 'node:url';

import { agentCorePortableRules } from '../eslint-rules.mjs';

import { loadTool } from './golden/tools.mjs';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const eslintModule = await loadTool('eslint');
const tsEslint = await loadTool('typescript-eslint');
const ESLint = eslintModule.ESLint ?? eslintModule.default.ESLint;
const parser = tsEslint.parser ?? tsEslint.default.parser;

const eslint = new ESLint({
  cwd:                pkgDir,
  overrideConfigFile: true,
  overrideConfig:     [{
    files:           ['src/**/*.ts'],
    languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' },
    rules:           agentCorePortableRules,
  }],
});

const results = await eslint.lintFiles(['src/**/*.ts']);
const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output) console.log(output);
const errors = results.reduce((n, r) => n + r.errorCount, 0);

const probe = await eslint.lintText(
  "import fs from 'node:fs';\nexport class Probe {}\nexport const leak = process.env.KEY;\n",
  { filePath: `${ pkgDir }src/__lint_probe__.ts` },
);
const fired = new Set(probe[0].messages.map(m => m.ruleId));
const missing = ['no-restricted-imports', 'no-restricted-syntax', 'no-restricted-globals'].filter(r => !fired.has(r));

console.log(`# lint: ${ results.length } files, ${ errors } errors; probe rules fired: ${ [...fired].join(', ') || 'none' }`);
if (missing.length) {
  console.error(`Portability rules did not fire on the probe: ${ missing.join(', ') }`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Agent core lint::rules did not fire on the probe: ${ missing.join(', ') }`);
}
if (errors || missing.length || results.length < 5) process.exitCode = 1;
