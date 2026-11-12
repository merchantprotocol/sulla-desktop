// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Native gate for an already-packaged app, without launching it:
 *   node scripts/ts-wrapper.js scripts/smoke-packaged-native.ts <path/to/Sulla Desktop.app> --arch=x64
 * Checks every addon's Node ABI and loads each required addon inside the
 * packaged Electron with ELECTRON_RUN_AS_NODE (no window, bounded by a timeout).
 */
import path from 'path';

import { NodeAbiElectronSource, PackagedAppNativeGate } from './lib/native-abi';
import { PackageTargetSpec } from './lib/package-target';

class SmokePackagedNativeCommand {
  run(argv: string[]): number {
    const appPath = argv.find(arg => arg.endsWith('.app'));
    const arch = (argv.find(arg => arg.startsWith('--arch=')) ?? '--arch=x64').slice('--arch='.length);
    const electronVersion = argv.find(arg => arg.startsWith('--electron='))?.slice('--electron='.length) ?? require(path.resolve('node_modules', 'electron', 'package.json')).version;

    if (!appPath) throw new Error('usage: smoke-packaged-native.ts <App.app> [--arch=x64|arm64] [--electron=<version>]');
    const target = PackageTargetSpec.resolve('darwin', arch);
    const problems = new PackagedAppNativeGate().problems(path.resolve(appPath), path.basename(appPath, '.app'), target.nativeDependencyPaths, new NodeAbiElectronSource().abiFor(electronVersion));

    for (const problem of problems) console.error(`FAIL ${ problem }`);
    console.log(problems.length ? `native gate FAILED (${ problems.length })` : 'native gate passed');

    return problems.length ? 1 : 0;
  }
}

try {
  process.exit(new SmokePackagedNativeCommand().run(process.argv.slice(2)));
} catch (error) {
  console.error(error);
  process.exit(2);
}
