// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Backward-compatible re-export — all logging now lives in SullaLogger.ts.
 */
export {
  SullaLogger,
  getSullaLogger,
  getSullaLogger as getConversationLogger,
  TopicLog,
  setLogLevel,
  type ConversationType,
  type ConversationMeta,
  type ConversationEvent,
} from './SullaLogger';
