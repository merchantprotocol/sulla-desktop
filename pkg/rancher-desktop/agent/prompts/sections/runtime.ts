/**
 * Runtime Section — Compact metadata line at the end of the prompt.
 * Priority: 200 (always last)
 * Modes: full, minimal
 *
 * NEW section — provides compact runtime context in a single line.
 */
import os from 'node:os';
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildRuntimeSection(ctx: PromptBuildContext): PromptSection | null {
  const now = new Date();
  const timeZone = ctx.templateVars['{{timeZone}}'] || Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const formattedTime = ctx.templateVars['{{formattedTime}}'] || now.toISOString();

  const parts = [
    `agent=${ ctx.agentId || 'sulla-desktop' }`,
    `host=${ os.hostname() }`,
    `os=${ os.platform() }`,
    `arch=${ os.arch() }`,
    `channel=${ ctx.wsChannel || 'workbench' }`,
    `time="${ formattedTime }"`,
    `tz=${ timeZone }`,
  ];

  const content = `<!-- runtime ${ parts.join(' ') } -->`;

  return {
    id:             'runtime',
    content,
    priority:       200,
    cacheStability: 'dynamic',
  };
}
