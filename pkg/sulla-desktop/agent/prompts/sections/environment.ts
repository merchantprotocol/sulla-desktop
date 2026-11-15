// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

For visual content (reports, statistics, dashboards, charts, tables, widgets): reply with \`<html><div class="vr">…</div></html>\` and put any \`<style>\` INSIDE that root div. A \`<style>\` placed right after \`<html>\` is dropped and every class stops working. An \`<html>\` or \`<style>\` tag anywhere turns the whole reply into HTML, so markdown inside it shows as raw text. \`<svg>\`, \`<script>\`, \`<iframe>\` and \`on*\` handlers are stripped: draw charts with divs, \`conic-gradient\` or an SVG data-URI \`<img>\`. Prefix classes with \`vr-\` (app classes like .tab, .chip and .badge leak in). Keep it within about 720px wide and 900px tall, with no entrance animations. Follow the \`sulla-make-a-visual-reply\` skill and run its check.py before posting.

Available CSS variables: \`--bg\`, \`--surface-1\` through \`--surface-3\`, \`--text\`, \`--text-secondary\` (labels and secondary text), \`--text-muted\` (only 18px and larger; it is too faint for small text on light cards), \`--accent\` (steel blue #5096b3 — primary brand color), \`--accent-hover\`, \`--accent-dim\`, \`--accent-border\`, \`--border\`, \`--border-muted\`, \`--info\`, \`--success\`, \`--warning\`, \`--danger\`. Do NOT use \`--green\` or \`--green-bright\` as accent colors — green is reserved for success/status only.
Fonts: \`var(--font-body, system-ui, sans-serif)\` for text, \`var(--font-display, system-ui, sans-serif)\` for headlines (a sans font, not Playfair), \`var(--font-mono, monospace)\` for numbers and code. Always give a fallback, and never use the \`font:\` shorthand with a var().
Aesthetic: follow the live app theme through these CSS variables; the human picks light or dark, so never force dark mode, noir or a black background. Use CSS variables — don't hardcode colors. Primary accent is \`--accent\`, not green. These variables exist only inside Sulla chat: for mockups, websites and standalone pages, never reuse them or the chat look — default to a bright, light design unless an approved design says otherwise.

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
  const folderMap = ctx.templateVars['{{folder_map}}'] || '';
  return [folderMap, installedExtensions].filter(Boolean).join('\n\n');
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
