// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getFips, setFips } from 'node:crypto';

export interface CryptoModuleStatus { provider:'openssl'; version:string; fips:boolean }

/** Reports the module and mode only. This is not a FIPS validation claim. */
export function configureCryptoModule(requireFips = process.env.SULLA_FILES_SYNC_REQUIRE_FIPS === 'true'):CryptoModuleStatus {
  if (process.env.OPENSSL_CONF && getFips() !== 1) {
    try {
      setFips(true);
    } catch {
      // No FIPS provider is loadable; fail closed below only when it is required.
    }
  }
  const status:CryptoModuleStatus = { provider: 'openssl', version: process.versions.openssl, fips: getFips() === 1 };
  if (requireFips && !status.fips) {
    throw Object.assign(new Error('Files cloud sync requires the configured OpenSSL FIPS provider'), { code: 'FILES_SYNC_FIPS_REQUIRED' });
  }
  return status;
}
