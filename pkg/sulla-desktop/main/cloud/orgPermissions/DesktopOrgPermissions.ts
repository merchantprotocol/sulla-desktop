// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { cloudRequest } from '../cloudFetch';
import { DesktopDeviceIdentity } from '../device/DesktopDeviceIdentity';
import { DesktopOrgPermissionSnapshotService } from './DesktopOrgPermissionSnapshotService';
import { FileOrgPermissionSnapshotStore } from './OrgPermissionSnapshotStore';
import { CloudOrgPermissionSnapshotTransport } from './OrgPermissionSnapshotTransport';

import paths from '@pkg/utils/paths';

/**
 * Composition root for Desktop's offline org permissions: Cloud transport over the signed-in session, the snapshot
 * cache in ~/.sulla, and this install's device id. One instance per process, created on first use.
 */
export class DesktopOrgPermissions {
  private static shared: DesktopOrgPermissionSnapshotService | null = null;

  static current(): DesktopOrgPermissionSnapshotService {
    DesktopOrgPermissions.shared ??= new DesktopOrgPermissionSnapshotService({
      transport: new CloudOrgPermissionSnapshotTransport(cloudRequest),
      store:     FileOrgPermissionSnapshotStore.in(() => paths.sullaConfig),
      deviceId:  () => DesktopDeviceIdentity.current().readExistingDeviceId(),
    });

    return DesktopOrgPermissions.shared;
  }

  /** Test seam: swap the process-wide instance (null = rebuild on next use). */
  static useInstance(instance: DesktopOrgPermissionSnapshotService | null): void {
    DesktopOrgPermissions.shared = instance;
  }
}
