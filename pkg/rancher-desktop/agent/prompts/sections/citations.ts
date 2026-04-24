/**
 * Citations Section — instructs the model to emit a trailing
 * `<citations><source … /></citations>` XML block when its answer
 * draws on specific sources (files, URLs, docs, memories).
 *
 * Priority: 78  (just below completion wrappers at 80, above voice at 75)
 * Modes: full, minimal
 *
 * The prompt text itself lives in CitationExtractor.ts so the extractor's
 * regex and the prompt instructions stay colocated — if the XML shape
 * ever changes, you update both lines next to each other instead of
 * hunting across files.
 */
import { CITATION_PROMPT } from '../../controllers/CitationExtractor';

import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildCitationsSection(_ctx: PromptBuildContext): PromptSection | null {
  return {
    id:             'citations',
    content:        CITATION_PROMPT.trim(),
    priority:       78,
    cacheStability: 'stable',
  };
}
