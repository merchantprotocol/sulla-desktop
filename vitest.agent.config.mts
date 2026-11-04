// SPDX-License-Identifier: GPL-2.0-or-later
// Vitest config for the agent-runtime test suite (OOP rebuild plan §4/§11).
// Tests live under pkg/sulla-desktop/agent/tests/** and run in GitHub CI
// (.github/workflows/agent-tests.yml) against a real Postgres service.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@pkg\/(.*)$/, replacement: path.join(root, 'pkg/sulla-desktop/$1') }],
  },
  test: {
    include:     ['pkg/sulla-desktop/agent/tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Specs that share the real database run in one worker, one file at a time.
    fileParallelism: false,
    passWithNoTests: true,
  },
});
