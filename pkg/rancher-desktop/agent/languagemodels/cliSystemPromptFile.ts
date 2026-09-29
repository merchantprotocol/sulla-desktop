/**
 * Per-spawn system prompt files for the CLI providers (Claude Code, Codex).
 *
 * Both CLIs run inside the Lima VM, so Sulla hands them the caller-built
 * system prompt as a file under ~/.sulla/system-prompts — mounted at the same
 * path in the VM, exactly like the MCP configs. Claude Code reads it through
 * --append-system-prompt-file, Codex through -c model_instructions_file.
 */

import type * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ChatMessage } from './BaseLanguageModel';

import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

const log = Logging.background;

/** Concatenated text of every system-role message — the caller-built system prompt. */
export function systemPromptFromMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system') continue;
    const c: any = m.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
        : '';
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join('\n\n');
}

/**
 * Write one spawn's system prompt where the VM can read it. Returns null when
 * there is nothing to write or the write fails — the spawn still proceeds.
 */
export function writeSystemPromptFile(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const dir = path.join(paths.sullaConfig, 'system-prompts');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${ crypto.randomUUID() }.md`);
    fs.writeFileSync(filePath, text, { mode: 0o600 });
    return filePath;
  } catch (err) {
    log.log(`[cliSystemPromptFile] write failed, spawning without it: ${ (err as Error)?.message ?? err }`);
    return null;
  }
}

/** Both CLIs read the file at boot and fail if it is missing, so delete only once the process exits. */
export function removeFileOnExit(proc: childProcess.ChildProcess, filePath: string | null): void {
  if (!filePath) return;
  proc.once('exit', () => {
    try { fs.unlinkSync(filePath) } catch { /* already gone */ }
  });
}
