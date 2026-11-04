// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Repository } from '@sulla/foundation';
import { WorkflowExecutionModel } from '../../database/models/WorkflowExecutionModel';

export class WorkflowExecutionRepository extends Repository<WorkflowExecutionModel> {
  protected readonly model = WorkflowExecutionModel;

  findStaleExecutions(): Promise<WorkflowExecutionModel[]> { return WorkflowExecutionModel.findStaleExecutions(); }
  findSuspended(): Promise<WorkflowExecutionModel[]> { return WorkflowExecutionModel.findSuspended(); }
  recover(executionId: string): ReturnType<typeof WorkflowExecutionModel.recover> { return WorkflowExecutionModel.recover(executionId); }
  suspendAllRunning(): Promise<string[]> { return WorkflowExecutionModel.suspendAllRunning(); }
  nextLeaseExpiry(): Promise<Date | null> { return WorkflowExecutionModel.nextLeaseExpiry(); }
}
