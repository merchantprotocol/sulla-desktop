/**
 * Compatibility builder for callers that still need the default Codex system
 * instructions. CodexService transports the caller-built prompt into the Sulla VM
 * guest per spawn; this module must never write host ~/.codex/AGENTS.md.
 */

export async function generateCodexMemoryFile(): Promise<string> {
  const { buildFullSystemPrompt } = await import('./buildFullSystemPrompt');
  return await buildFullSystemPrompt({ provider: 'openai' });
}
