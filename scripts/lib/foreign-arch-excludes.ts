// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MacBuildArchitecture, type MacBuildArch } from './mac-build-architecture';

/**
 * Where webpack's node-loader emits `.node` addons that get bundled into
 * `dist/app` (posix-node's per-CPU addons are bundled, not external). The
 * loader's default name is only a content hash, which carries no architecture,
 * so build-utils names them `native/[name].[contenthash].[ext]`: the addon's
 * own basename (which names its CPU) plus the hash, so two addons with the
 * same basename from different packages never collide on one emitted file.
 */
export const EMITTED_NATIVE_DIR = 'native';
export const EMITTED_NATIVE_NAME = `${ EMITTED_NATIVE_DIR }/[name].[contenthash].[ext]`;

/**
 * Native packages ship one prebuild per CPU. `yarn install --ignore-platform`
 * pulls both Mac architectures, and a bundle for one architecture must not
 * carry the other's Mach-O files (an Intel app was shipped with arm64
 * node-pty, xattr, onnxruntime, sherpa-onnx and posix-node binaries).
 * This builds the electron-builder `files` exclusions for the architecture
 * that is NOT being packaged.
 */
export class ForeignArchExcludes {
  /** posix-node names its addons `<zig arch>-<zig os>.node` and picks one with `process.arch`. */
  private static readonly POSIX_NODE_NAME: Record<MacBuildArch, string> = { x64: 'x86_64', arm64: 'aarch64' };

  /** The architecture whose binaries must be left out of a `target` build. */
  foreignArch(target: MacBuildArch): MacBuildArch {
    return MacBuildArchitecture.parse(target).foreign.node;
  }

  /**
   * `files` negations (electron-builder glob syntax) for a `target` Mac build.
   * Only the other CPU's Mac files are named, so every file a runtime
   * `require` can reach on `target` (including Rosetta, where
   * `process.arch` is x64) stays.
   */
  globsFor(target: MacBuildArch): string[] {
    const foreign = this.foreignArch(target);
    const posixName = ForeignArchExcludes.POSIX_NODE_NAME[foreign];

    return [
      `!**/node_modules/*/prebuilds/darwin-${ foreign }/**`,
      `!**/node_modules/@*/*/prebuilds/darwin-${ foreign }/**`,
      `!**/node_modules/@napi-rs/xattr-darwin-${ foreign }{,/**}`,
      `!**/node_modules/sherpa-onnx-darwin-${ foreign }{,/**}`,
      `!**/node_modules/onnxruntime-node/bin/napi-v*/darwin/${ foreign }/**`,
      `!**/node_modules/posix-node/dist/${ posixName }-macos.node`,
      // Emitted as `<zig arch>-macos.<hex content hash>.node` (EMITTED_NATIVE_NAME).
      `!dist/app/${ EMITTED_NATIVE_DIR }/${ posixName }-macos.+([0-9a-f]).node`,
    ];
  }
}

/**
 * posix-node is only called on Linux (background.ts puts Electron in its own
 * process group there). Its macOS addons are Zig-built Mach-O files that
 * SIGILL once codesign rewrites them, and nothing on a Mac ever loads them, so
 * a Mac package carries neither CPU's copy rather than a signed binary that
 * crashes if it is ever touched. Signing and architecture checks stay on.
 */
export class UnusedMacAddonExcludes {
  globs(): string[] {
    return [
      '!**/node_modules/posix-node/dist/*-macos.node',
      `!dist/app/${ EMITTED_NATIVE_DIR }/*-macos.+([0-9a-f]).node`,
    ];
  }
}
