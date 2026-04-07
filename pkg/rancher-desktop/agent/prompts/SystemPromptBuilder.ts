/**
 * SystemPromptBuilder — Section-based prompt composition system.
 *
 * Assembles the agent system prompt from independently-toggled sections,
 * each with its own priority, cache stability, and mode support.
 *
 * Inspired by OpenClaw's architecture:
 * - Sections are registered factories that return content or null (skip)
 * - Cache boundary splits stable vs dynamic content for Anthropic KV cache
 * - Prompt modes (full/minimal/none) control which sections are included
 * - Agent config .md files can override any section by matching the section ID
 */

import type { ChatMode } from '../controllers/ChatController';

// ============================================================================
// Types
// ============================================================================

export interface PromptSection {
  /** Unique section identifier (e.g. 'soul', 'safety', 'tooling') */
  id: string;
  /** Rendered prompt text */
  content: string;
  /** Sort order — lower = earlier in the prompt */
  priority: number;
  /** Whether this section is stable (cacheable) or dynamic (changes per turn) */
  cacheStability: 'stable' | 'dynamic';
}

export interface PromptBuildContext {
  /** Prompt mode: full (main agent), minimal (subagents), none (pass-through) */
  mode: 'full' | 'minimal' | 'none';
  /** Agent identifier (e.g. 'observer', 'code-researcher') */
  agentId: string;
  /** Parsed agent config.yaml, if available */
  agentConfig: AgentConfig | null;
  /** LLM provider name */
  provider: 'anthropic' | 'openai' | 'ollama' | 'google' | string;
  /** Current chat mode */
  chatMode: ChatMode;
  /** User trust level */
  trustLevel: 'trusted' | 'verify' | 'untrusted';
  /** Whether this is a sub-agent */
  isSubAgent: boolean;
  /** Whether this is the heartbeat (autonomous) agent */
  isHeartbeat: boolean;
  /** WebSocket channel name */
  wsChannel: string;
  /** Template variables for {{placeholder}} substitution */
  templateVars: Record<string, string>;
  /** Section overrides from agent .md files: section_id → file content */
  agentSectionOverrides: Map<string, string>;
  /** Sections to exclude entirely (from config.yaml exclude_sections) */
  excludeSections: Set<string>;
  /** Base prompt passed by the caller (node-specific content) */
  basePrompt: string;
}

export interface AgentConfig {
  name?: string;
  prompt?: string;
  tools?: string[];
  integrations?: string[];
  excludeSoul?: boolean;
  exclude_sections?: string[];
  [key: string]: any;
}

export interface BuiltPrompt {
  /** Full prompt text (joined with \n\n for all providers) */
  text: string;
  /** Anthropic cache-optimized content blocks */
  anthropicSystem?: AnthropicSystemBlock[];
  /** Which sections were included in the build */
  includedSections: string[];
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Factory function that produces a section or null to skip it */
export type SectionFactory = (ctx: PromptBuildContext) => PromptSection | null | Promise<PromptSection | null>;

/** Registered section with its factory and metadata */
interface RegisteredSection {
  id: string;
  factory: SectionFactory;
  /** Which modes this section is enabled for */
  modes: Set<string>;
}

// ============================================================================
// Builder
// ============================================================================

class SystemPromptBuilderImpl {
  private sections = new Map<string, RegisteredSection>();

  /**
   * Register a section factory.
   * @param id       Unique section identifier
   * @param factory  Factory function that returns a PromptSection or null
   * @param modes    Which prompt modes this section is enabled for (default: ['full'])
   */
  register(id: string, factory: SectionFactory, modes: string[] = ['full']): void {
    this.sections.set(id, { id, factory, modes: new Set(modes) });
  }

  /** Unregister a section by ID. */
  unregister(id: string): void {
    this.sections.delete(id);
  }

  /** Get all registered section IDs. */
  getRegisteredSectionIds(): string[] {
    return [...this.sections.keys()];
  }

  /**
   * Build the complete system prompt from registered sections.
   */
  async build(ctx: PromptBuildContext): Promise<BuiltPrompt> {
    // Mode 'none' — just return the base prompt, no sections
    if (ctx.mode === 'none') {
      return {
        text:             ctx.basePrompt || 'You are a personal assistant operating inside Sulla Desktop.',
        includedSections: [],
      };
    }

    // Collect sections
    const builtSections: PromptSection[] = [];

    for (const [id, reg] of this.sections) {
      // Skip if mode doesn't match
      if (!reg.modes.has(ctx.mode)) continue;

      // Skip if agent config excludes this section
      if (ctx.excludeSections.has(id)) continue;

      // Check for agent config override
      const override = ctx.agentSectionOverrides.get(id);
      if (override !== undefined) {
        // Use override content with the factory's default priority/stability
        // We still call the factory to get the default metadata (priority, cacheStability)
        // but replace the content with the override
        try {
          const defaultSection = await reg.factory(ctx);
          if (defaultSection) {
            builtSections.push({
              ...defaultSection,
              content: override,
            });
          } else {
            // Factory returned null (section would be skipped), but agent wants to override it.
            // Use sensible defaults.
            builtSections.push({
              id,
              content:        override,
              priority:       50,
              cacheStability: 'stable',
            });
          }
        } catch {
          // Factory errored — use the override with defaults
          builtSections.push({
            id,
            content:        override,
            priority:       50,
            cacheStability: 'stable',
          });
        }
        continue;
      }

      // Call the factory
      try {
        const section = await reg.factory(ctx);
        if (section && section.content?.trim()) {
          builtSections.push(section);
        }
      } catch (err) {
        console.error(`[SystemPromptBuilder] Section "${ id }" failed:`, err);
      }
    }

    // Sort by priority
    builtSections.sort((a, b) => a.priority - b.priority);

    // Append base prompt if provided (as the final section)
    if (ctx.basePrompt?.trim()) {
      builtSections.push({
        id:             '_base_prompt',
        content:        ctx.basePrompt.trim(),
        priority:       999,
        cacheStability: 'dynamic',
      });
    }

    // Split into stable and dynamic
    const stableSections = builtSections.filter(s => s.cacheStability === 'stable');
    const dynamicSections = builtSections.filter(s => s.cacheStability === 'dynamic');

    // Build full text
    const allContent = builtSections.map(s => s.content);
    const text = allContent.join('\n\n');
    const includedSections = builtSections.map(s => s.id);

    // Build Anthropic-optimized blocks (stable block with cache_control, then dynamic)
    let anthropicSystem: AnthropicSystemBlock[] | undefined;
    if (ctx.provider === 'anthropic') {
      anthropicSystem = [];

      if (stableSections.length > 0) {
        const stableText = stableSections.map(s => s.content).join('\n\n');
        anthropicSystem.push({
          type:          'text',
          text:          stableText,
          cache_control: { type: 'ephemeral' },
        });
      }

      if (dynamicSections.length > 0) {
        const dynamicText = dynamicSections.map(s => s.content).join('\n\n');
        anthropicSystem.push({
          type: 'text',
          text: dynamicText,
        });
      }
    }

    return { text, anthropicSystem, includedSections };
  }
}

// ============================================================================
// Singleton
// ============================================================================

export const SystemPromptBuilder = new SystemPromptBuilderImpl();
