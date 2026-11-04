// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { decisionService } from '../services/DecisionService';
import { PublishApprovalCoordinator } from './files/PublishApprovalCoordinator';
import { DesktopSnapshotRegistry } from './desktop/DesktopSnapshotRegistry';
import { DesktopTargetPolicy } from './desktop/DesktopTargetPolicy';

/** Application composition root for stateful tool collaborators. */
export class ToolRuntime {
  readonly publishApprovalCoordinator = new PublishApprovalCoordinator(decisionService);
  readonly desktopSnapshotRegistry = new DesktopSnapshotRegistry();
  readonly desktopTargetPolicy = new DesktopTargetPolicy();

  start(): void { this.publishApprovalCoordinator.start(); }
  dispose(): void {
    this.publishApprovalCoordinator.dispose();
    this.desktopSnapshotRegistry.dispose();
  }
}

export const toolRuntime = new ToolRuntime();
toolRuntime.start();
