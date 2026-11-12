// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DesktopDeviceIdentity, SettingsLegacyDeviceIdSource } from './DesktopDeviceIdentity';

import paths from '@pkg/utils/paths';

/** The one device identity for this install (composition root). Paths and the app version are read lazily. */
export const thisDevice = DesktopDeviceIdentity.forDirectory(
  () => paths.sullaConfig,
  async() => (await import('@pkg/utils/version')).getProductionVersion(),
  new SettingsLegacyDeviceIdSource(),
);
