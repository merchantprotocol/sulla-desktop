// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Extract terminal assistant text, never diagnostics or tool output, from CLI JSONL. */
export function providerResult(provider: string, logs: string): string | null {
  let result: string | null = null;
  for (const raw of logs.split('\n')) {
    const line = raw.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '');
    let event: any;
    try { event = JSON.parse(line) } catch { continue }
    if (provider === 'codex') {
      // A resumed turn supersedes a previous answer, even if the new turn fails.
      if (event.type === 'turn.started') result = null;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        result = event.item.text;
      }
    } else if (provider === 'claude-code' && event.type === 'result') {
      result = event.is_error !== true && typeof event.result === 'string' ? event.result : null;
    }
  }
  return result;
}
