// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const BYTES_PER_MEGABYTE = 1_000_000;

/**
 * Formats a storage cleanup byte count in decimal megabytes (1 MB = 1,000,000 bytes).
 * Amounts under 1,000 bytes keep six decimals so a nonzero amount never displays as 0 MB.
 */
export function formatStorageMegabytes(bytes:number | null | undefined):string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'Unavailable';
  if (bytes === 0) return '0 MB';
  const maximumFractionDigits = Math.abs(bytes) < 1000 ? 6 : 3;
  return `${ (bytes / BYTES_PER_MEGABYTE).toLocaleString(undefined, { maximumFractionDigits }) } MB`;
}
