import type { ModelDescriptor } from '../models/Thread';

/**
 * List of available models. For phase 0 this is hardcoded; phase 4
 * fetches from `sulla meta/list_models` or an agent endpoint.
 */
export const defaultModels: readonly ModelDescriptor[] = Object.freeze([
  { id: 'claude-opus-4-7',     name: 'opus-4.7',    tier: 'hosted', ctx: '1M ctx'   },
  { id: 'claude-sonnet-4-6',   name: 'sonnet-4.6',  tier: 'hosted', ctx: '200K ctx' },
  { id: 'claude-haiku-4-5',    name: 'haiku-4.5',   tier: 'hosted', ctx: '200K ctx' },
  { id: 'gpt-5-thinking',      name: 'gpt-5-think', tier: 'hosted', ctx: '128K ctx' },
  { id: 'mixtral-8x22b',       name: 'mixtral',     tier: 'local',  ctx: '64K ctx'  },
  { id: 'qwen-2-5-coder-32b',  name: 'qwen-coder',  tier: 'local',  ctx: '32K ctx'  },
]);

export function findModel(id: string): ModelDescriptor | null {
  return defaultModels.find(m => m.id === id) ?? null;
}
