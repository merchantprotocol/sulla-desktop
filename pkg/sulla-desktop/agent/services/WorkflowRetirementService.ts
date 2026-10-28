// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Logging from '@pkg/utils/logging';

const console = Logging.background;

/** Retire durable runs and signal any in-process walkers to stop cooperatively. */
export async function retireWorkflowExecutions(workflowId: string): Promise<string[]> {
  const { WorkflowExecutionModel } = await import('../database/models/WorkflowExecutionModel');
  const executionIds = await WorkflowExecutionModel.retireActiveByWorkflow(workflowId);
  if (executionIds.length === 0) return executionIds;

  const { requestWorkflowStop } = await import('../tools/workflow/stop_workflow');
  await Promise.all(executionIds.map(async(executionId) => {
    try {
      await requestWorkflowStop(executionId, 'Workflow archived');
    } catch (error) {
      // Durable settlement already prevents recovery; keep archive available
      // when Redis is temporarily unavailable.
      console.warn(`[WorkflowRetirement] Could not signal ${ executionId } to stop:`, error);
    }
  }));

  return executionIds;
}
