// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

function required(name: string, value: string | undefined): string {
  const result = value?.trim() ?? '';
  if (!result) throw new Error(`${ name } is required`);
  return result;
}

const installationSecret = process.env.SULLA_API_TOKEN?.trim() ?? '';

export const config = {
  port:        Number(process.env.SULLA_AGENT_SERVICE_PORT ?? 8789),
  // No default: a missing value stops startup (manager.ts) instead of using a public password.
  databaseUrl: process.env.SULLA_DATABASE_URL?.trim() ?? '',
  localToken:  required('SULLA_API_TOKEN', installationSecret),
};

if (Buffer.byteLength(config.localToken) < 32) throw new Error('SULLA_API_TOKEN must contain at least 32 bytes');
