// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createAnthropicMessagesAdapter } from './anthropicMessages.js';
import { createOpenAIChatAdapter } from './openaiChat.js';

import type { AnthropicMessagesOptions } from './anthropicMessages.js';
import type { OpenAIChatOptions } from './openaiChat.js';
import type { ProviderAdapter, ProviderApi } from './types.js';

export * from './anthropicMessages.js';
export * from './openaiChat.js';
export * from './sse.js';
export * from './types.js';

export function createAdapter(api: ProviderApi, options: AnthropicMessagesOptions & OpenAIChatOptions = {}): ProviderAdapter {
  switch (api) {
  case 'anthropic-messages':
    return createAnthropicMessagesAdapter(options);
  case 'openai-chat':
    return createOpenAIChatAdapter(options);
  default:
    throw new Error(`Unknown provider API: ${ String(api) }`);
  }
}
