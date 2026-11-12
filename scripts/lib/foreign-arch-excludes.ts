// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type MacBuildArch = 'x64' | 'arm64';

/**
 * Native packages ship one prebuild per CPU. `yarn install --ignore-platform`
 * pulls both Mac architectures, and a bundle for one architecture must not
 * carry the other's Mach-O files (an Intel app was shipped with arm64
 * node-pty, xattr, onnxruntime, sherpa-onnx and posix-node binaries).
 * This builds the electron-builder `files` exclusions for the architecture
 * that is NOT being packaged.
 */
export class ForeignArchExcludes {
  private static readonly POSIX_NODE_NAME: Record<MacBuildArch, string> = { x64: 'x86_64', arm64: 'aarch64' };

  /** The architecture whose binaries must be left out of a `target` build. */
  foreignArch(target: MacBuildArch): MacBuildArch {
    return target === 'x64' ? 'arm64' : 'x64';
  }

  /** `files` negations (electron-builder glob syntax) for a `target` Mac build. */
  globsFor(target: MacBuildArch): string[] {
    const foreign = this.foreignArch(target);

    return [
      `!**/node_modules/*/prebuilds/darwin-${ foreign }/**`,
      `!**/node_modules/@napi-rs/xattr-darwin-${ foreign }{,/**}`,
      `!**/node_modules/sherpa-onnx-darwin-${ foreign }{,/**}`,
      `!**/node_modules/onnxruntime-node/bin/napi-v*/darwin/${ foreign }/**`,
      `!**/node_modules/posix-node/dist/${ ForeignArchExcludes.POSIX_NODE_NAME[foreign] }-macos.node`,
    ];
  }
}
