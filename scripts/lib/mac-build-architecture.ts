// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type MacBuildArch = 'x64' | 'arm64';

/**
 * The one place a Node architecture name becomes a Mac build architecture.
 * An unsupported value (ia32, ppc64, a typo in `--arch=`) must stop the
 * build; it must never fall through to arm64, which is how an Intel package
 * could end up carrying Apple Silicon binaries.
 */
export class MacBuildArchitecture {
  private constructor(readonly node: MacBuildArch) {}

  static parse(arch: string): MacBuildArchitecture {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(`Unsupported Mac build architecture "${ arch }": only x64 and arm64 can be packaged`);
    }

    return new MacBuildArchitecture(arch);
  }

  /** The `uname -m` / Mach-O name used by the asset and runtime build scripts. */
  get uname(): 'x86_64' | 'arm64' {
    return this.node === 'x64' ? 'x86_64' : 'arm64';
  }

  /** The other Mac architecture. */
  get foreign(): MacBuildArchitecture {
    return new MacBuildArchitecture(this.node === 'x64' ? 'arm64' : 'x64');
  }
}
