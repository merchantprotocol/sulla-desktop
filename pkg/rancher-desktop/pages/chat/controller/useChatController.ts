/*
  provide/inject plumbing so components can reach the active controller
  without importing it directly.

  Usage in a container:
    import { provideChatController } from './controller/useChatController';
    provideChatController(controller);

  Usage in a descendant component:
    import { useChatController } from './controller/useChatController';
    const controller = useChatController();
    // controller.send('hi'), controller.messages.value, etc.
*/

import { inject, provide, type InjectionKey } from 'vue';

import type { AgentModelSelectorController } from '@pkg/pages/agent/AgentModelSelectorController';

import type { ChatController }   from './ChatController';
import type { ThreadRegistry }   from './ThreadRegistry';

export const ChatControllerKey:  InjectionKey<ChatController>               = Symbol('ChatController');
export const ThreadRegistryKey:  InjectionKey<ThreadRegistry>               = Symbol('ThreadRegistry');
export const ModelSelectorKey:   InjectionKey<AgentModelSelectorController> = Symbol('ModelSelector');

export function provideChatController(c: ChatController): void {
  provide(ChatControllerKey, c);
}
export function useChatController(): ChatController {
  const c = inject(ChatControllerKey);
  if (!c) throw new Error('[useChatController] no ChatController provided by a parent component.');
  return c;
}

export function provideThreadRegistry(r: ThreadRegistry): void {
  provide(ThreadRegistryKey, r);
}
export function useThreadRegistry(): ThreadRegistry {
  const r = inject(ThreadRegistryKey);
  if (!r) throw new Error('[useThreadRegistry] no ThreadRegistry provided by a parent component.');
  return r;
}

export function provideModelSelector(s: AgentModelSelectorController): void {
  provide(ModelSelectorKey, s);
}
export function useModelSelector(): AgentModelSelectorController {
  const s = inject(ModelSelectorKey);
  if (!s) throw new Error('[useModelSelector] no AgentModelSelectorController provided by a parent component.');
  return s;
}
