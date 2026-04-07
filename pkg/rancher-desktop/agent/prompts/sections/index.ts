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
SystemPromptBuilder.register('identity',            buildIdentitySection,            ['full', 'minimal']);
SystemPromptBuilder.register('soul',                buildSoulSection,                ['full']);
SystemPromptBuilder.register('safety',              buildSafetySection,              ['full', 'minimal']);
SystemPromptBuilder.register('execution_bias',      buildExecutionBiasSection,       ['full']);
SystemPromptBuilder.register('tooling',             buildToolingSection,             ['full', 'minimal']);
SystemPromptBuilder.register('narration_policy',    buildNarrationPolicySection,     ['full']);
SystemPromptBuilder.register('environment',         buildEnvironmentSection,         ['full']);
SystemPromptBuilder.register('skills',              buildSkillsSection,              ['full']);
SystemPromptBuilder.register('workspace',           buildWorkspaceSection,           ['full', 'minimal']);
SystemPromptBuilder.register('trust',               buildTrustSection,               ['full', 'minimal']);
SystemPromptBuilder.register('voice_mode',          buildVoiceModeSection,           ['full']);
SystemPromptBuilder.register('completion_wrappers', buildCompletionWrappersSection,  ['full', 'minimal']);
SystemPromptBuilder.register('agent_prompt',        buildAgentPromptSection,         ['full', 'minimal']);

// Dynamic sections (change per turn — after cache boundary)
SystemPromptBuilder.register('channel_awareness',   buildChannelAwarenessSection,    ['full']);
SystemPromptBuilder.register('heartbeat',           buildHeartbeatSection,           ['full']);
SystemPromptBuilder.register('silent_reply',        buildSilentReplySection,         ['full']);
SystemPromptBuilder.register('runtime',             buildRuntimeSection,             ['full', 'minimal']);

/** All registered section IDs — useful for matching agent .md file overrides */
export const REGISTERED_SECTION_IDS = new Set(SystemPromptBuilder.getRegisteredSectionIds());
