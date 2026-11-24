// SPDX-License-Identifier: GPL-2.0-or-later

import { ref } from 'vue';
import type { ChatMessage } from '@pkg/pages/agent/ChatInterface';

/** Preview-only stand-in at the legacy persona boundary; the renderer adapter stays real. */
export class ChatInterface {
  readonly threadId = ref<string | null>(null);
  readonly messages = ref<ChatMessage[]>([]);
  readonly messagesRevision = ref(0);
  readonly graphRunning = ref(false);
  readonly hasMessages = ref(true);
  readonly showContinueButton = ref(false);
  readonly query = ref('');
  readonly totalTokensUsed = ref(0);
  readonly totalPromptTokens = ref(0);
  readonly totalCompletionTokens = ref(0);
  readonly totalCost = ref(0);
  readonly totalInputCost = ref(0);
  readonly totalOutputCost = ref(0);
  readonly responseCount = ref(0);
  readonly averageResponseTime = ref(0);
  readonly tokensPerSecond = ref(0);

  onSpeakDispatch(): () => void { return () => undefined }
  stop(): void {}
  continueRun(): void {}
  newChat(): void {}
  dispose(): void {}

  async send(): Promise<never> { throw new Error('Sending is disabled in the synthetic chat preview.') }
  async injectMessage(): Promise<never> { return this.send() }
}
