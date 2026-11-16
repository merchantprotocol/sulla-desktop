// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { chatHeartbeatProvider } from '../app/Providers/ChatHeartbeatServiceProvider';
import type { ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';

/** @deprecated Use chatHeartbeatProvider.scheduler() from app/Providers/ChatHeartbeatServiceProvider. */
export function getChatHeartbeatService(): ChatHeartbeatScheduler {
  return chatHeartbeatProvider.scheduler();
}

export { ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';
