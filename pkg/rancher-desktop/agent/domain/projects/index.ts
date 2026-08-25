/**
 * Projects domain kernel (dHAe refactor, Phase 1).
 *
 * Pure, framework-free domain primitives for the Projects work-graph. No SQL, no Electron,
 * no persistence imports. Existing SQL-backed models (WorkItemsModel, WorkLaneDefinitionModel,
 * WorkflowExecutionModel, ...) are intended to route through this kernel via compatibility
 * adapters in later phases. This kernel changes no public tool or IPC contract.
 */
export * from './values';
export * from './entities';
export * from './lifecycle';
export * from './compatibility';
export { DomainError } from './errors';
