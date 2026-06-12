/**
 * Section Registry — Registers all prompt sections with the SystemPromptBuilder.
 *
 * Import this module once at startup to register all sections.
 * Sections are registered with their modes (which prompt modes they are active for).
 */
import { SystemPromptBuilder } from '../SystemPromptBuilder';
import { buildAgentPromptSection } from './agentPrompt';
import { buildChannelAwarenessSection } from './channelAwareness';
import { buildCitationsSection } from './citations';
import { buildCompletionWrappersSection } from './completionWrappers';
import { buildEnvironmentSection } from './environment';
import { buildHeartbeatSection } from './heartbeat';
import { buildIdentitySection } from './identity';
import { buildNarrationPolicySection } from './narrationPolicy';
import { buildObservationalMemorySection } from './observationalMemory';
import { buildSafetySection } from './safety';
import { buildSilentReplySection } from './silentReply';
import { buildSkillsSection } from './skills';
import { buildSoulSection } from './soul';
import { buildToolingSection } from './tooling';
import { buildTrustSection } from './trust';
import { buildWorkspaceSection } from './workspace';

// ============================================================================
// Register all sections
// ============================================================================

// Stable sections (cached across turns)
// 'local' mode includes condensed variants of most sections for small-context local LLMs.
SystemPromptBuilder.register('identity', buildIdentitySection, ['full', 'minimal', 'local']);
SystemPromptBuilder.register('soul', buildSoulSection, ['full', 'local']);
SystemPromptBuilder.register('safety', buildSafetySection, ['full', 'minimal', 'local']);
SystemPromptBuilder.register('tooling', buildToolingSection, ['full', 'minimal', 'local']);
SystemPromptBuilder.register('narration_policy', buildNarrationPolicySection, ['full', 'local']);
SystemPromptBuilder.register('environment', buildEnvironmentSection, ['full', 'local']);
SystemPromptBuilder.register('skills', buildSkillsSection, ['full', 'local']);
SystemPromptBuilder.register('workspace', buildWorkspaceSection, ['full', 'minimal', 'local']);
SystemPromptBuilder.register('observational_memory', buildObservationalMemorySection, ['full', 'local']);
SystemPromptBuilder.register('trust', buildTrustSection, ['full', 'minimal', 'local']);
SystemPromptBuilder.register('completion_wrappers', buildCompletionWrappersSection, ['full', 'minimal', 'local']);
SystemPromptBuilder.register('citations', buildCitationsSection, ['full', 'minimal']);
SystemPromptBuilder.register('agent_prompt', buildAgentPromptSection, ['full', 'minimal', 'local']);
SystemPromptBuilder.register('channel_awareness', buildChannelAwarenessSection, ['full', 'local']);
SystemPromptBuilder.register('heartbeat', buildHeartbeatSection, ['full', 'local']);
SystemPromptBuilder.register('silent_reply', buildSilentReplySection, ['full', 'local']);

// Per-turn dynamic content (current time, live agent roster, voice-mode
// directive) no longer lives in the system prompt — it travels in the
// <turn_context> block appended to the latest user message so the system
// prompt stays byte-stable across turns. See ../turnContext.ts and
// BaseNode.injectTurnContext().

/** All registered section IDs — useful for matching agent .md file overrides */
export const REGISTERED_SECTION_IDS = new Set(SystemPromptBuilder.getRegisteredSectionIds());
