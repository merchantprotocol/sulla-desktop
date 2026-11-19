// SPDX-License-Identifier: GPL-2.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';

const workflowWrite = new AsyncLocalStorage<boolean>();
export const WORKFLOW_SETTINGS_PREFIX = 'productOwnerWorkflow.';
export function withWorkflowWrite<T>(operation: () => T): T { return workflowWrite.run(true, operation) }
export function assertWorkflowWrite(property: string): void {
  if (property.startsWith(WORKFLOW_SETTINGS_PREFIX) && !workflowWrite.getStore()) throw new Error('Change chat workflow choices in the Workflow panel.');
}
