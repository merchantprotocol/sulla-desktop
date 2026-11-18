// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { inject } from 'vue';
import { CONV_STORE, type ConversationScreenStore } from './ConversationScreenStore';

/** Returns the Conversations screen store provided by the Conversations root component. */
export function useConvStore(): ConversationScreenStore {
  const store = inject<ConversationScreenStore>(CONV_STORE);
  if (!store) throw new Error('Conversations components must render inside the Conversations root');
  return store;
}
