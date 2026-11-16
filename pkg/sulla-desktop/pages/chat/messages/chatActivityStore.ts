// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive } from 'vue';

import type { ThreadActivityState } from './threadActivity';

/** Each chat tab's current activity, keyed by browser tab id, for the tab strip's dots. */
export const chatActivityByTab = reactive(new Map<string, ThreadActivityState>());
