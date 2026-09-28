/**
 * Which tools the Reflex engine may learn and fire on its own.
 *
 * Reflex acts BEFORE the language model sees the message, so everything it can
 * fire must be local, fast, and harmless if it guesses wrong. New actions are
 * learned automatically, but only inside these categories and never for tools
 * or arguments that delete, run arbitrary code, or type into pages.
 */

export const DEFAULT_REFLEX_CATEGORIES = ['browser', 'ui', 'docker', 'project', 'capture', 'secretary', 'notify'];

/** Tools inside allowed categories that must still never fire without the model. */
const DENIED_TOOLS = new Set([
  // docker: destructive or arbitrary execution
  'docker_exec', 'docker_rm', 'docker_stop', 'docker_build', 'docker_run', 'docker_images', 'docker_pull',
  // browser: page interaction, code, and state mutation
  'eval_js', 'manage_cookies', 'modify_history', 'click', 'fill', 'form', 'type_at', 'click_at', 'press_key',
  'hover', 'scroll', 'agent_storage', 'schedule_alarm', 'background_browse', 'monitor_network',
]);

/** Argument values that turn an otherwise-safe tool destructive. */
const DESTRUCTIVE_ARG = /^(remove|delete|destroy|drop|close|archive|kill|stop|purge|reset)$/i;

export interface ReflexPolicyInput {
  toolName:          string;
  category:          string | undefined;
  params:            Record<string, unknown>;
  allowedCategories: string[];
}

/** Returns null when allowed, otherwise the reason it is not. */
export function reflexPolicyViolation(input: ReflexPolicyInput): string | null {
  if (!input.category) return `tool "${ input.toolName }" is not registered`;
  if (!input.allowedCategories.includes(input.category)) {
    return `category "${ input.category }" is not allowed for reflex actions (allowed: ${ input.allowedCategories.join(', ') })`;
  }
  if (DENIED_TOOLS.has(input.toolName)) return `tool "${ input.toolName }" is never allowed to fire as a reflex`;
  for (const [key, value] of Object.entries(input.params ?? {})) {
    if (typeof value === 'string' && DESTRUCTIVE_ARG.test(value.trim())) {
      return `argument ${ key }="${ value }" is destructive`;
    }
  }
  return null;
}

export function parseCategories(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_REFLEX_CATEGORIES;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
