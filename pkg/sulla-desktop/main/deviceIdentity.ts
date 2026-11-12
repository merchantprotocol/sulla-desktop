// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Desktop device id — thin delegates to `DesktopDeviceIdentity` (main/cloud/device), kept so
 * existing callers don't change. The id lives in ~/.sulla/device-id (outside Electron's
 * userData, so it survives reinstalls); older installs are migrated out of SullaSettings.
 * New ids come only from the CSPRNG; there is no Math.random fallback.
 */

import { thisDevice } from './cloud/device/thisDevice';

export type { DesktopDeviceMetadata } from './cloud/device/DesktopDeviceIdentity';

/** The full device metadata payload expected by the server's /devices/register endpoint. */
export function getDesktopDeviceMetadata() {
  return thisDevice.metadata();
}

/** The Cloud device id if this install already has one; never creates one or touches the database. */
export function readExistingDesktopDeviceId(): string | null {
  return thisDevice.readExistingDeviceId();
}

export async function getDesktopDeviceId(): Promise<string> {
  return thisDevice.deviceId();
}
