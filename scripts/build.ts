// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This script builds the javascript, without packaging it up for use.  This is
 * mostly useful for more comprehensive checking.
 */

'use strict';

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import buildUtils from './lib/build-utils';

import { simpleSpawn } from 'scripts/simple_process';

class Builder {
  async cleanup() {
    console.log('Removing previous builds...');
    const dirs = [
      path.resolve(buildUtils.rendererSrcDir, 'dist'),
      path.resolve(buildUtils.distDir),
    ];
    const options = {
      force: true, maxRetries: 3, recursive: true,
    };

    await Promise.all(dirs.map(dir => fs.rm(dir, options)));
  }

  async buildRenderer() {
    process.env.VUE_CLI_SERVICE_CONFIG_PATH = 'pkg/sulla-desktop/vue.config.mjs';
    await simpleSpawn(
      process.execPath,
      [
        '--stack-size=16384',
        'node_modules/@vue/cli-service/bin/vue-cli-service.js',
        'build',
        '--skip-plugins',
        'eslint',
      ],
    );
  }

  /**
   * Compile the native audio-driver helpers (create-mirror, capture-loopback)
   * for the host architecture and stage them into resources/darwin/audio-driver/.
   * Must run before buildMain/packaging so the binaries match the build arch —
   * the committed prebuilt binary is arm64-only and would break Intel macs.
   */
  async buildAudioNative() {
    if (os.platform() !== 'darwin') {
      return;
    }
    await simpleSpawn('bash', ['scripts/build-audio-native.sh']);
  }

  async build() {
    console.log('Building...');
    buildUtils.isDevelopment = false;
    await this.buildAudioNative();
    await this.buildRenderer();
    await buildUtils.buildPreload();
    await buildUtils.buildMain();
    await buildUtils.buildCli();
  }

  async run() {
    await this.cleanup();
    await this.build();
  }
}

(new Builder()).run().catch((e) => {
  console.error(e);
  process.exit(1);
});
