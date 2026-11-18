// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
export class ThreatProtectionLogic {
  isValidHost(value: string): boolean { return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(value.trim()); }
  megabytesToBytes(value: number): number { return Math.round(value * 1024 * 1024); }
  logRequest(search: string, verdict: string) { return { limit: 200, verdict: verdict || undefined, search: search || undefined }; }
  allowlist(value: string): string[] { return value.split(',').map(host => host.trim()).filter(Boolean); }
}
