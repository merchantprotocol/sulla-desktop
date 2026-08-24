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
 * - Agent config .md files can override sections by matching the section ID
 *   (except Heartbeat's frozen operator contract)
 */

import { checkHeartbeatPromptInvariants, type HeartbeatInvariantResult } from './heartbeatInvariants';

import type { ChatMode } from '../controllers/ChatController';

// ============================================================================
// Types
// ============================================================================

export interface PromptSection {
  /** Unique section identifier (e.g. 'soul', 'safety', 'tooling') */
  id:             string;
  /** Rendered prompt text */
  content:        string;
  /** Sort order — lower = earlier in the prompt */
  priority:       number;
  /**
   * Cache tier:
   * - 'stable'      — effectively frozen for the session (soul, safety, tooling)
   * - 'semi-stable' — changes occasionally, not per turn (observational memory).
   *                   Gets its own cache breakpoint so an update only
   *                   invalidates this segment, not the whole stable prefix.
   * - 'dynamic'     — changes every turn (runtime, channel awareness); sits
   *                   after the cache boundary.
   */
  cacheStability: 'stable' | 'semi-stable' | 'dynamic';
}

export interface PromptBuildContext {
  /** Prompt mode: full (main agent), minimal (subagents), local (condensed for local LLMs), none (pass-through) */
  mode:                  'full' | 'minimal' | 'local' | 'none';
  /** Agent identifier (e.g. 'observer', 'code-researcher') */
  agentId:               string;
  /** Parsed agent config.yaml, if available */
  agentConfig:           AgentConfig | null;
  /** LLM provider name */
  provider:              'anthropic' | 'openai' | 'ollama' | 'google' | string;
  /** Current chat mode */
  chatMode:              ChatMode;
  /** User trust level */
  trustLevel:            'trusted' | 'verify' | 'untrusted';
  /** Whether this is a sub-agent */
  isSubAgent:            boolean;
  /** Whether this is the heartbeat (autonomous) agent */
  isHeartbeat:           boolean;
  /** WebSocket channel name */
  wsChannel:             string;
  /** Tool exposure mode: 'slim' pushes only the minimal native set + catalog discovery; 'full' pushes resolved schemas */
  toolMode?:             'slim' | 'full';
  /** Template variables for {{placeholder}} substitution */
  templateVars:          Record<string, string>;
  /** Section overrides from agent .md files: section_id → file content */
  agentSectionOverrides: Map<string, string>;
  /** Sections to exclude entirely (from config.yaml exclude_sections) */
  excludeSections:       Set<string>;
  /**
   * DB-backed prompt sections (SystemPromptSectionModel), keyed by id — the
   * editable CORE layer. Enabled rows only. The subconscious-produced `user`
   * row is returned as assistant context instead of system content. For any
   * other REGISTERED section id the
   * content replaces the baked factory content (unless an agent .md override is
   * present, which still wins, or the section is generated — see isGenerated).
   * A row whose id has no registered factory is injected as a NEW section using
   * its own priority/cacheStability. Optional: when undefined (empty/unreachable
   * DB, or a caller/test that doesn't set it) the baked factories are used.
   */
  dbSections?:           Map<string, DbPromptSection>;
  /** Base prompt passed by the caller (node-specific content) */
  basePrompt:            string;
}

/** A DB-backed section row projected into the build context. */
export interface DbPromptSection {
  content:        string;
  priority:       number;
  cacheStability: 'stable' | 'semi-stable' | 'dynamic';
  /**
   * The section's body is partly runtime-generated (e.g. `environment`). Its
   * factory composes the DB content (static preamble) with the live tail, so
   * the builder does NOT blindly replace it — the factory reads dbSections itself.
   */
  isGenerated:    boolean;
}

export interface AgentConfig {
  name?:             string;
  prompt?:           string;
  tools?:            string[];
  integrations?:     string[];
  excludeSoul?:      boolean;
  exclude_sections?: string[];
  [key: string]:     any;
}

export interface BuiltPrompt {
  /** Full prompt text (joined with \n\n for all providers) */
  text:                     string;
  /** Anthropic cache-optimized content blocks */
  anthropicSystem?:         AnthropicSystemBlock[];
  /** Which sections were included in the build */
  includedSections:         string[];
  /**
   * Contextual sections that must be delivered as assistant-role context,
   * never as system instructions. This includes the `observational_memory`
   * recall section and the dream-consolidated DB `user` section.
   */
  assistantContextSections: PromptSection[];
  /**
   * Heartbeat-only: runtime invariant check of the composed prompt — confirms
   * the deployed continuous-operator wording is present and the #581 STOP-ceiling
   * framing is absent. Undefined for non-heartbeat builds. See heartbeatInvariants.
   */
  heartbeatInvariants?:     HeartbeatInvariantResult;
}

export interface AnthropicSystemBlock {
  type:           'text';
  text:           string;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' };
}

/**
 * Raised before a Heartbeat wake can receive a prompt whose ownership or
 * continuous-operation contract has drifted from the compiled invariants.
 */
export class HeartbeatPromptInvariantError extends Error {
  constructor(public readonly invariants: HeartbeatInvariantResult) {
    const details = [
      invariants.missing.length ? `missing: ${ invariants.missing.join(', ') }` : '',
      invariants.forbidden.length ? `forbidden: ${ invariants.forbidden.join(', ') }` : '',
    ].filter(Boolean).join('; ');

    super(
      'Heartbeat prompt invariant failure; refusing to start the wake' +
      (details ? ` (${ details })` : ''),
    );
    this.name = 'HeartbeatPromptInvariantError';
  }
}

/** Factory function that produces a section or null to skip it */
export type SectionFactory = (ctx: PromptBuildContext) => PromptSection | null | Promise<PromptSection | null>;

/** Registered section with its factory and metadata */
interface RegisteredSection {
  id:      string;
  factory: SectionFactory;
  /** Which modes this section is enabled for */
  modes:   Set<string>;
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
        text:                     ctx.basePrompt || 'You are a personal assistant operating inside Sulla Desktop.',
        includedSections:         [],
        assistantContextSections: [],
      };
    }

    // Collect sections
    const builtSections: PromptSection[] = [];
    const assistantContextSections: PromptSection[] = [];

    for (const [id, reg] of this.sections) {
      // Skip if mode doesn't match
      if (!reg.modes.has(ctx.mode)) continue;

      // Heartbeat's operator contract is frozen and DB-backed. Legacy files in
      // ~/sulla/agents/heartbeat previously leaked in through two paths:
      // heartbeat.md replaced the registered heartbeat section, while files
      // such as PLAYBOOK.md were concatenated into agent_prompt. Both paths
      // made stale install-local doctrine outrank the shipped contract.
      if (ctx.isHeartbeat && id === 'agent_prompt') continue;
      const isFrozenHeartbeatSection = ctx.isHeartbeat && id === 'heartbeat';

      // Skip if agent config excludes this section
      if (ctx.excludeSections.has(id) && !isFrozenHeartbeatSection) continue;

      // Check for agent config override
      const override = isFrozenHeartbeatSection
        ? undefined
        : ctx.agentSectionOverrides.get(id);
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

      // Call the factory ONCE. It enforces mode/gating (e.g. the heartbeat
      // section returns null unless ctx.isHeartbeat) — a null result means the
      // section is off for this build, and the DB must NOT resurrect it.
      let section: PromptSection | null = null;
      try {
        section = await reg.factory(ctx);
      } catch (err) {
        console.error(`[SystemPromptBuilder] Section "${ id }" failed:`, err);
        continue;
      }
      if (!section) continue;

      // Layer 2: DB row content replaces the baked factory content, keeping the
      // factory's priority/cacheStability. Generated sections (isGenerated) are
      // left as-is — their factory already composed the DB static preamble with
      // the live runtime tail (it reads ctx.dbSections directly).
      // The compiled Heartbeat contract is replace-only from source control.
      // A DB row is install-local state just like an agent markdown override;
      // accepting it here would silently bypass the frozen section guard above.
      const dbRow = isFrozenHeartbeatSection ? undefined : ctx.dbSections?.get(id);
      if (dbRow && !dbRow.isGenerated && dbRow.content?.trim()) {
        builtSections.push({ ...section, content: dbRow.content });
      } else if (section.content?.trim()) {
        builtSections.push(section);
      }
    }

    // Inject CUSTOM DB sections — enabled rows whose id has no registered
    // factory (e.g. `user` and any user-added sections). Full/local modes only;
    // disabled rows are already absent from ctx.dbSections and excluded ids are
    // skipped. Registered ids were handled in the loop above.
    if (ctx.dbSections && (ctx.mode === 'full' || ctx.mode === 'local')) {
      for (const [id, row] of ctx.dbSections) {
        if (this.sections.has(id)) continue;
        if (ctx.excludeSections.has(id)) continue;
        if (!row.content?.trim()) continue;
        const section = {
          id,
          content:        row.content,
          priority:       row.priority,
          cacheStability: row.cacheStability,
        };
        if (id === 'user') {
          assistantContextSections.push(section);
        } else {
          builtSections.push(section);
        }
      }
    }

    // Observational memory is subconscious context, not governing policy.
    // Factories still build it normally, but it leaves the system section list
    // here and travels through the same assistant-role carrier as the DB user
    // identity section.
    for (let i = builtSections.length - 1; i >= 0; i--) {
      if (builtSections[i].id !== 'observational_memory') continue;
      assistantContextSections.unshift(builtSections[i]);
      builtSections.splice(i, 1);
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

    // Split by cache tier
    const stableSections = builtSections.filter(s => s.cacheStability === 'stable');
    const semiStableSections = builtSections.filter(s => s.cacheStability === 'semi-stable');
    const dynamicSections = builtSections.filter(s => s.cacheStability === 'dynamic');

    // For local/ollama providers, enforce stable-before-dynamic ordering in the text output.
    // llama-server's KV cache reuses the longest matching prefix — putting all stable (unchanging)
    // content first maximizes cache hits across turns, even if a dynamic section has a low priority.
    const orderedSections = (ctx.provider === 'ollama' || ctx.mode === 'local')
      ? [...stableSections, ...semiStableSections, ...dynamicSections]
      : builtSections;

    // Build full text
    const allContent = orderedSections.map(s => s.content);
    const text = allContent.join('\n\n');
    const includedSections = orderedSections.map(s => s.id);

    // Build Anthropic-optimized blocks: stable (cached) → semi-stable (own
    // cache breakpoint) → dynamic (uncached, after the boundary). Prompt
    // caching is a prefix match, so giving semi-stable content (observational
    // memory) its own breakpoint means a memory update only re-writes that
    // segment — the stable prefix's cache entry stays valid.
    let anthropicSystem: AnthropicSystemBlock[] | undefined;
    if (ctx.provider === 'anthropic') {
      anthropicSystem = [];

      // The heartbeat fires every 15 minutes, but the default cache TTL is
      // 5 minutes — every cycle would pay the cache-write premium and never
      // read. The 1h TTL costs 2x to write but is read by the next ~3 cycles.
      const cacheControl: AnthropicSystemBlock['cache_control'] = ctx.isHeartbeat
        ? { type: 'ephemeral', ttl: '1h' }
        : { type: 'ephemeral' };

      if (stableSections.length > 0) {
        anthropicSystem.push({
          type:          'text',
          text:          stableSections.map(s => s.content).join('\n\n'),
          cache_control: cacheControl,
        });
      }

      if (semiStableSections.length > 0) {
        anthropicSystem.push({
          type:          'text',
          text:          semiStableSections.map(s => s.content).join('\n\n'),
          cache_control: cacheControl,
        });
      }

      if (dynamicSections.length > 0) {
        anthropicSystem.push({
          type: 'text',
          text: dynamicSections.map(s => s.content).join('\n\n'),
        });
      }
    }

    // Heartbeat self-verification: on the autonomous wake path, confirm the
    // DEPLOYED prompt still carries the continuous-operator invariants. A stale
    // binary running reverted prompt code (e.g. PR #581's pick-one/STOP ceiling)
    // passes the source-level tests on main but fails here at runtime — turning
    // the manual "rebuild + eyeball the live prompt" gate into an automatic
    // signal. Fail closed before BaseNode can hand a stale prompt to the LLM.
    let heartbeatInvariants: HeartbeatInvariantResult | undefined;
    if (ctx.isHeartbeat) {
      heartbeatInvariants = checkHeartbeatPromptInvariants(text);
      if (!heartbeatInvariants.ok) {
        throw new HeartbeatPromptInvariantError(heartbeatInvariants);
      }
    }

    return { text, anthropicSystem, includedSections, assistantContextSections, heartbeatInvariants };
  }
}

// ============================================================================
// Singleton
// ============================================================================

export const SystemPromptBuilder = new SystemPromptBuilderImpl();
