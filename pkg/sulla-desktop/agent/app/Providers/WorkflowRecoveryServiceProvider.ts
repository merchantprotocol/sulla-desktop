// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { WorkflowExecutionRepository } from '../Repositories/WorkflowExecutionRepository';
import { WorkflowRecoveryService, type SuspendedExecution } from '../Services/WorkflowRecovery/WorkflowRecoveryService';
import Logging from '@pkg/utils/logging';

class SystemRecoveryClock {
  now(): number { return Date.now(); }
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> { return setTimeout(callback, delay); }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { clearTimeout(timer); }
  defer(callback: () => void): void { setImmediate(callback); }
}
class DesktopRecoveryNotifier {
  async notify(execution: SuspendedExecution): Promise<void> {
    Logging.background.warn(`[WorkflowRecovery] workflow run paused and waiting for you: ${ execution.workflowName } (${ execution.executionId })`);
    try {
      const { getChromeApi } = await import('@pkg/main/chromeApi/ChromeApiService');
      await getChromeApi().notifications.create(`workflow-paused-${ execution.executionId }`, {
        title: `Workflow paused: ${ execution.workflowName }`,
        message: 'It stopped mid-run and needs a decision before it can run again. Open Workflows to resume or stop it.',
      });
    } catch (error) { Logging.background.warn('[WorkflowRecovery] could not show paused-routine notification:', error); }
  }
}
class DesktopWorkflowRecoveryRegistry {
  async activate(execution: SuspendedExecution): Promise<void> {
    const { GraphRegistry } = await import('../../services/GraphRegistry');
    const { activateWorkflowOnState } = await import('../../tools/workflow/execute_workflow');
    const { state } = await GraphRegistry.getOrCreateOverlordGraph('heartbeat', `[Recovery] Auto-restarting workflow "${ execution.workflowName }" that was interrupted on last shutdown.`);
    await activateWorkflowOnState(state, { workflowId: execution.workflowSlug, resumeExecutionId: execution.executionId });
  }
}

export const workflowRecoveryService = new WorkflowRecoveryService(
  new WorkflowExecutionRepository(),
  new DesktopWorkflowRecoveryRegistry(), new SystemRecoveryClock(), new DesktopRecoveryNotifier(),
);
