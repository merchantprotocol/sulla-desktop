/**
 * ChatDisplayContext — shared display facts (bot identity, theme) for
 * message components, provided once by the chat page so the message
 * registry loop only has to pass the message itself.
 */

import { inject, provide, ref } from 'vue';

import type { ComputedRef, InjectionKey, Ref } from 'vue';

export interface ChatDisplayContext {
  botName:    Ref<string> | ComputedRef<string>;
  botLogoUrl: string;
  isDark:     Ref<boolean> | ComputedRef<boolean>;
}

const ChatDisplayKey: InjectionKey<ChatDisplayContext> = Symbol('chat-display');

export function provideChatDisplay(ctx: ChatDisplayContext): void {
  provide(ChatDisplayKey, ctx);
}

export function useChatDisplay(): ChatDisplayContext {
  return inject(
    ChatDisplayKey,
    () => ({ botName: ref('Sulla'), botLogoUrl: '', isDark: ref(true) }),
    true,
  );
}
