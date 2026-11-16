// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import sodium from 'libsodium-wrappers-sumo';

import { FilesKeyBundleCodec } from './FilesKeyBundleCodec.js';
import { SodiumRuntime } from './SodiumRuntime.js';
import { VaultCipher } from './VaultCipher.js';
import { VaultItemEncryptor } from './VaultItemEncryptor.js';
import { VaultKeyDerivation } from './VaultKeyDerivation.js';
import { VaultKeyWrapper } from './VaultKeyWrapper.js';

/**
 * Composition root for the package. Callers that want injection build their own instance from a
 * SodiumRuntime; the package's legacy named exports delegate to `VaultCrypto.shared()`, which is
 * created on first use (importing the package never initialises sodium).
 */
export class VaultCrypto {
  private static sharedInstance: VaultCrypto | undefined;

  readonly cipher:          VaultCipher;
  readonly keys:            VaultKeyDerivation;
  readonly keyWrapper:      VaultKeyWrapper;
  readonly items:           VaultItemEncryptor;
  readonly filesKeyBundles: FilesKeyBundleCodec;

  constructor(runtime: SodiumRuntime) {
    this.cipher = new VaultCipher(runtime);
    this.keys = new VaultKeyDerivation(runtime, this.cipher);
    this.keyWrapper = new VaultKeyWrapper(this.cipher);
    this.items = new VaultItemEncryptor(this.cipher);
    this.filesKeyBundles = new FilesKeyBundleCodec(this.cipher);
  }

  static shared(): VaultCrypto {
    VaultCrypto.sharedInstance ??= new VaultCrypto(new SodiumRuntime(sodium));
    return VaultCrypto.sharedInstance;
  }
}
