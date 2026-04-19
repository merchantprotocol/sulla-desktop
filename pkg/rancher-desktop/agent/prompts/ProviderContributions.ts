/**
 * ProviderContributions — Per-provider prompt overrides and injections.
 *
 * Each LLM provider can contribute:
 * - stablePrefix: injected before the cache boundary
 * - dynamicSuffix: injected after the cache boundary
 * - overrides: replace specific section content
 */

export interface ProviderContribution {
  /** Stable text injected before the cache boundary */
  stablePrefix?:  string;
  /** Dynamic text injected after the cache boundary */
  dynamicSuffix?: string;
  /** Override specific section content by section ID */
  overrides?:     Record<string, string>;
}

const contributions = new Map<string, ProviderContribution>();

/**
 * Register a provider contribution.
 */
export function registerProviderContribution(provider: string, contribution: ProviderContribution): void {
  contributions.set(provider, contribution);
}

/**
 * Get the contribution for a provider.
 */
export function getProviderContribution(provider: string): ProviderContribution | undefined {
  return contributions.get(provider);
}

// ============================================================================
// Default provider contributions
// ============================================================================

// Anthropic — thinking format hints (if thinking is enabled)
registerProviderContribution('anthropic', {
  // No special prefix/suffix needed for now — the cache boundary
  // is handled by SystemPromptBuilder's Anthropic system blocks.
});

// Ollama — shorter prompts for smaller context windows
registerProviderContribution('ollama', {
  stablePrefix: 'You are running on a local Ollama model. Keep responses concise to fit within context limits.',
});
