// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { WorkflowRecoveryService as ApplicationWorkflowRecoveryService } from '../app/Services/WorkflowRecovery/WorkflowRecoveryService';
export type { SuspendedExecution } from '../app/Services/WorkflowRecovery/WorkflowRecoveryService';
import { workflowRecoveryService } from '../app/Providers/WorkflowRecoveryServiceProvider';

/** @deprecated Import the application service directly for new code. */
export class WorkflowRecoveryService extends ApplicationWorkflowRecoveryService {}
export async function recoverOnBoot(): Promise<void> { await workflowRecoveryService.recover(); }
export function getPendingSuspended() { return workflowRecoveryService.takePending(); }
export async function gracefulShutdown(): Promise<void> { await workflowRecoveryService.gracefulShutdown(); }
