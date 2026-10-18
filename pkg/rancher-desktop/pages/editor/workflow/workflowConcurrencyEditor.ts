import type { WorkflowDefinition } from './types';

export function concurrencyInputValue(definition: Partial<WorkflowDefinition>): string {
  const configured = Number(definition.maxConcurrentRuns);
  if (Number.isSafeInteger(configured) && configured > 0) return String(configured);
  return definition.concurrencyPolicy === 'allow' ? '' : '1';
}

export function concurrencyValueForSave(input: string, definition: Partial<WorkflowDefinition>): number | undefined {
  if (input.trim() === '' && definition.concurrencyPolicy === 'allow' && definition.maxConcurrentRuns === undefined) return undefined;
  const value = Number(input);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
