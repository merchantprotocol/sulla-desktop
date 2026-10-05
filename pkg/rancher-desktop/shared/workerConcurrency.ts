export const WORKER_CONCURRENCY_KEY = 'routineConcurrencyTotalLimit';
export const DEFAULT_WORKER_CONCURRENCY = 5;

export function isValidWorkerConcurrency(value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1;
}

export function normalizeWorkerConcurrency(value: unknown): number {
  return isValidWorkerConcurrency(value) ? Number(value) : DEFAULT_WORKER_CONCURRENCY;
}
