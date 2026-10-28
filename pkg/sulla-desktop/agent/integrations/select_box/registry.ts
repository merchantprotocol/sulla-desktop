// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SelectBoxProvider } from './SelectBoxProvider';

const providers = new Map<string, SelectBoxProvider>();

export function registerSelectBoxProvider(provider: SelectBoxProvider): void {
  providers.set(provider.id, provider);
}

export function getSelectBoxProvider(id: string): SelectBoxProvider | undefined {
  return providers.get(id);
}

export function getAllSelectBoxProviders(): Map<string, SelectBoxProvider> {
  return providers;
}
