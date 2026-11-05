// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import buildUtils from './lib/build-utils';

class AgentProductionBundleChecker {
  async run(): Promise<void> {
    buildUtils.isDevelopment = false;
    await buildUtils.buildJavaScript(buildUtils.webpackConfig);
  }
}

new AgentProductionBundleChecker().run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
