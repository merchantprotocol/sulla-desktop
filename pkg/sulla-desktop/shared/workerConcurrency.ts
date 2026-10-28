// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
