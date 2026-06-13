/**
 * Overwrites ~/.codex/AGENTS.md with the full Sulla system prompt so the
 * codex CLI picks it up natively at startup — the codex equivalent of
 * generateClaudeCodeMemoryFile (codex reads AGENTS.md from CODEX_HOME the
 * way Claude Code reads ~/.claude/CLAUDE.md).
 *
 * Called on every codex session spawn so the file stays current.
 */

import * as fs from 'fs';
import * as path from 'path';

import { codexHomeDir } from '../util/codexAuthFile';

export async function generateCodexMemoryFile(): Promise<void> {
  try {
    const { buildFullSystemPrompt } = await import('./buildFullSystemPrompt');
    const systemPrompt = await buildFullSystemPrompt({ provider: 'openai' });

    if (!systemPrompt?.trim()) return;

    const dir = codexHomeDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), systemPrompt, 'utf-8');
  } catch {
    // Non-fatal — don't block the agent spawn if the write fails
  }
}
