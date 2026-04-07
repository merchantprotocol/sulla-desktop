/**
 * Voice Mode Section — Voice/secretary/intake mode directives.
 * Priority: 75
 * Modes: full
 *
 * Migrated from prompts/voiceModes.ts. Gated on ctx.chatMode.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';
import { VOICE_MODE_PROMPT, SECRETARY_MODE_PROMPT, INTAKE_MODE_PROMPT } from '../voiceModes';

export function buildVoiceModeSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;

  let content: string;
  switch (ctx.chatMode) {
  case 'voice':
    content = VOICE_MODE_PROMPT;
    break;
  case 'secretary':
    content = SECRETARY_MODE_PROMPT;
    break;
  case 'intake':
    content = INTAKE_MODE_PROMPT;
    break;
  default:
    // Text mode — no voice directive needed
    return null;
  }

  return {
    id:             'voice_mode',
    content,
    priority:       75,
    cacheStability: 'stable',
  };
}
