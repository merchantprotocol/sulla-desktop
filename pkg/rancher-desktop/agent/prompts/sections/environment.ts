/**
 * Environment Section — Response formatting and integration instructions.
 * Priority: 50
 * Modes: full
 *
 * Migrated from prompts/environment.ts.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildEnvironmentSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;

  const integrationsIndex = ctx.templateVars['{{integrations_index}}'] || '';
  const integrationsInstructions = ctx.templateVars['{{integrations_instructions}}'] || '';
  const installedExtensions = ctx.templateVars['{{installed_extensions}}'] || '';

  let content = `# Response Formatting

For visual content (dashboards, charts, tables, widgets): wrap your entire response in \`<html>...</html>\` tags. The chat UI renders it in an isolated Shadow DOM with the Noir Terminal Editorial design system pre-loaded.

Available CSS variables: \`--bg\`, \`--surface-1\` through \`--surface-3\`, \`--text\`, \`--text-muted\`, \`--text-dim\`, \`--green\`, \`--green-bright\`, \`--green-glow\`, \`--border\`, \`--border-muted\`, \`--info\`, \`--success\`, \`--warning\`, \`--danger\`.
Fonts: \`var(--font-display)\` (Playfair Display for headlines), \`var(--font-mono)\` (JetBrains Mono for body/code), \`var(--font-body)\` (system sans for long text).
Aesthetic: dark mode only, green-on-black, noir cinematic feel. Use CSS variables — don't hardcode colors.

For notifications: use \`notify_user\` via the Tools API when the user is not looking at the chat.
For simple text: use markdown.`;

  if (integrationsInstructions) {
    content += `\n\n# Tools API\n\n${ integrationsInstructions }`;
  }

  if (integrationsIndex) {
    content += `\n\n# Available Integrations\n\n${ integrationsIndex }`;
  }

  if (installedExtensions) {
    content += `\n\n${ installedExtensions }`;
  }

  return {
    id:             'environment',
    content,
    priority:       50,
    cacheStability: 'stable',
  };
}
