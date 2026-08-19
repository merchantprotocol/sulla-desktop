/**
 * Environment Section — Response formatting and integration instructions.
 * Priority: 50
 * Modes: full
 *
 * Migrated from prompts/environment.ts.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

/**
 * The STATIC, editable half of the environment section. This is the baked
 * default seeded into the `environment` DB row (see systemPromptSectionDefaults).
 * At compile time the runtime-generated tail (installed extensions, integrations)
 * is appended after whatever the DB row / factory supplies here.
 */
export const ENVIRONMENT_STATIC_PREAMBLE = `# Response Formatting

For visual content (reports, statistics, dashboards, charts, tables, widgets): wrap your entire response in \`<html>...</html>\` tags. The chat UI renders it as HTML.

Available CSS variables: \`--bg\`, \`--surface-1\` through \`--surface-3\`, \`--text\`, \`--text-muted\`, \`--text-dim\`, \`--accent\` (steel blue #5096b3 — primary brand color), \`--accent-hover\`, \`--accent-dim\`, \`--accent-border\`, \`--border\`, \`--border-muted\`, \`--info\`, \`--success\`, \`--warning\`, \`--danger\`. Do NOT use \`--green\` or \`--green-bright\` as accent colors — green is reserved for success/status only.
Fonts: \`var(--font-display)\` (Playfair Display for headlines), \`var(--font-mono)\` (JetBrains Mono for body/code), \`var(--font-body)\` (system sans for long text).
Aesthetic: dark mode only, steel blue accent on dark backgrounds, noir cinematic feel. Use CSS variables — don't hardcode colors. Primary accent is \`--accent\` (steel blue), not green.

For notifications: use \`notify_user\` via the Tools API when the user is not looking at the chat.
For simple text: use markdown.`;

/**
 * Build ONLY the runtime-generated tail of the environment section — the live
 * installed-extensions / integrations data. Exposed so the settings UI can show
 * the human exactly what gets injected (read-only preview) without duplicating
 * the assembly logic.
 */
export function buildEnvironmentDynamic(ctx: PromptBuildContext): string {
  const installedExtensions = ctx.templateVars['{{installed_extensions}}'] || '';
  return installedExtensions ? installedExtensions : '';
}

export function buildEnvironmentSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;

  // Static preamble comes from the editable DB row when present, else the baked
  // default. The runtime-generated tail (installed extensions, etc.) is always
  // appended after it — this is why `environment` is flagged is_generated and
  // the builder does not blindly replace it.
  const dbStatic = ctx.dbSections?.get('environment')?.content;
  const staticPart = dbStatic && dbStatic.trim() ? dbStatic : ENVIRONMENT_STATIC_PREAMBLE;

  const dynamic = buildEnvironmentDynamic(ctx);
  const content = dynamic ? `${ staticPart }\n\n${ dynamic }` : staticPart;

  return {
    id:             'environment',
    content,
    priority:       50,
    cacheStability: 'stable',
  };
}
