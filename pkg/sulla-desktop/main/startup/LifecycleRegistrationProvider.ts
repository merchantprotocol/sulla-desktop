// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';

/** A group of ServiceLifecycleManager registrations; groups register in a fixed order. */
export interface LifecycleRegistrationProvider {
  readonly name: string;
  register(lifecycle: ServiceLifecycleManager): void;
}
