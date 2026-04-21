/**
 * Overwrites ~/.claude/CLAUDE.md with the full Sulla system prompt so Claude
 * Code picks it up natively at startup. The entire prepared system prompt is
 * written — no cherry-picking, no section markers, no partial injection.
 *
 * Called on every Claude Code session spawn AND whenever observational memory
 * is updated (add/remove_observational_memory tools) so the file stays current.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export async function generateClaudeCodeMemoryFile(): Promise<void> {
  try {
    const { buildFullSystemPrompt } = await import('./buildFullSystemPrompt');
    const systemPrompt = await buildFullSystemPrompt({ provider: 'anthropic' });

    if (!systemPrompt?.trim()) return;

    const claudeDir  = path.join(os.homedir(), '.claude');
    const claudePath = path.join(claudeDir, 'CLAUDE.md');

    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(claudePath, systemPrompt, 'utf-8');
  } catch {
    // Non-fatal — don't block the agent spawn if the write fails
  }
}
