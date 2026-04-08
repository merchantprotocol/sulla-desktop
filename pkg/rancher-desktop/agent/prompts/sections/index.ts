/**
 * Section Registry — Registers all prompt sections with the SystemPromptBuilder.
 *
 * Import this module once at startup to register all sections.
 * Sections are registered with their modes (which prompt modes they are active for).
 */
import { SystemPromptBuilder } from '../SystemPromptBuilder';

import { buildIdentitySection } from './identity';
import { buildSoulSection } from './soul';
import { buildSafetySection } from './safety';
import { buildExecutionBiasSection } from './executionBias';
import { buildToolingSection } from './tooling';
import { buildNarrationPolicySection } from './narrationPolicy';
import { buildEnvironmentSection } from './environment';
import { buildSkillsSection } from './skills';
import { buildWorkspaceSection } from './workspace';
import { buildTrustSection } from './trust';
import { buildVoiceModeSection } from './voiceMode';
import { buildCompletionWrappersSection } from './completionWrappers';
import { buildAgentPromptSection } from './agentPrompt';
import { buildChannelAwarenessSection } from './channelAwareness';
import { buildHeartbeatSection } from './heartbeat';
import { buildSilentReplySection } from './silentReply';
import { buildRuntimeSection } from './runtime';

// ============================================================================
// Register all sections
// ============================================================================

// Stable sections (cached across turns)
// 'local' mode includes condensed variants of most sections for small-context local LLMs.
SystemPromptBuilder.register('identity',            buildIdentitySection,            ['full', 'minimal', 'local']);
SystemPromptBuilder.register('soul',                buildSoulSection,                ['full', 'local']);
SystemPromptBuilder.register('safety',              buildSafetySection,              ['full', 'minimal', 'local']);
SystemPromptBuilder.register('execution_bias',      buildExecutionBiasSection,       ['full', 'local']);
SystemPromptBuilder.register('tooling',             buildToolingSection,             ['full', 'minimal', 'local']);
SystemPromptBuilder.register('narration_policy',    buildNarrationPolicySection,     ['full', 'local']);
SystemPromptBuilder.register('environment',         buildEnvironmentSection,         ['full', 'local']);
SystemPromptBuilder.register('skills',              buildSkillsSection,              ['full', 'local']);
SystemPromptBuilder.register('workspace',           buildWorkspaceSection,           ['full', 'minimal', 'local']);
SystemPromptBuilder.register('trust',               buildTrustSection,               ['full', 'minimal', 'local']);
SystemPromptBuilder.register('voice_mode',          buildVoiceModeSection,           ['full', 'local']);
SystemPromptBuilder.register('completion_wrappers', buildCompletionWrappersSection,  ['full', 'minimal', 'local']);
SystemPromptBuilder.register('agent_prompt',        buildAgentPromptSection,         ['full', 'minimal', 'local']);

// Dynamic sections (change per turn — after cache boundary)
SystemPromptBuilder.register('channel_awareness',   buildChannelAwarenessSection,    ['full', 'local']);
SystemPromptBuilder.register('heartbeat',           buildHeartbeatSection,           ['full', 'local']);
SystemPromptBuilder.register('silent_reply',        buildSilentReplySection,         ['full', 'local']);
SystemPromptBuilder.register('runtime',             buildRuntimeSection,             ['full', 'minimal', 'local']);

/** All registered section IDs — useful for matching agent .md file overrides */
export const REGISTERED_SECTION_IDS = new Set(SystemPromptBuilder.getRegisteredSectionIds());
