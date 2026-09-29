/** Short human labels for Reflex actions — shown on the composer's live-intent chip. */

const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function urlHost(url: unknown): string {
  try {
    return new URL(String(url)).host || String(url);
  } catch {
    return String(url);
  }
}

/** Short human label for a Reflex action, e.g. "Open Projects". */
export function reflexActionLabel(toolName: string, params: Record<string, unknown>): string {
  if (toolName === 'open_tab') {
    if (typeof params.mode === 'string' && params.mode) return `Open ${ titleCase(params.mode) }`;
    if (params.url) return `Open ${ urlHost(params.url) }`;
  }
  if (toolName === 'tab') {
    if (params.action === 'remove') return 'Close tab';
    if (params.url) return `Open ${ urlHost(params.url) }`;
  }
  const detail = Object.values(params ?? {}).find(v => typeof v === 'string' && v.length <= 40) as string | undefined;
  return detail ? `${ titleCase(toolName) }: ${ detail }` : titleCase(toolName);
}
