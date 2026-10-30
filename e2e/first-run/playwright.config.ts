// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: /first-run\.spec\.ts/,
  timeout: 60_000, retries: 0, workers: 1,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../../test-results/first-run', reporter: [['list'], ['json', { outputFile: '../../test-results/first-run/results.json' }]],
});
