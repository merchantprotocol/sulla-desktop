/**
 * Minimal test harness for driving Claude Code headlessly inside the Lima VM.
 *
 * Exposes an IPC handler `claude-code:test` that:
 *   1. Spawns `claude -p PROMPT --output-format stream-json --verbose
 *      --include-partial-messages --dangerously-skip-permissions` in the VM
 *      via `limactl shell`.
 *   2. Parses each NDJSON line and logs the event type + interesting fields.
 *   3. Streams progress back to the renderer via `claude-code:test:event`.
 *   4. Resolves with { events, sessionId, text } when `message_stop` is seen
 *      (or on process exit).
 *
 * This is a throwaway test path to confirm the experience before wiring
 * Claude Code into the real chat backend. Not committed until proven.
 */

import * as childProcess from 'child_process';

import { resolveLimactlPath, resolveLimaHome } from '@pkg/agent/tools/util/CommandRunner';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

interface StreamEvent {
  type?:       string;
  session_id?: string;
  uuid?:       string;
  event?: {
    type?:          string;
    content_block?: { type?: string; name?: string; id?: string };
    delta?: {
      type?:         string;
      text?:         string;
      thinking?:     string;
      partial_json?: string;
    };
    message?: {
      id?:          string;
      content?:     { type?: string; text?: string; name?: string; input?: unknown }[];
      stop_reason?: string;
    };
  };
  message?:  unknown;
  subtype?:  string;
  is_error?: boolean;
  result?:   string;
}

interface TestResult {
  ok:         boolean;
  error?:     string;
  sessionId?: string;
  events:     number;
  text:       string;
  stderr:     string;
  exitCode:   number | null;
}

export function initClaudeCodeTestEvents(): void {
  const ipcMainProxy = getIpcMainProxy(console);

  ipcMainProxy.handle('claude-code:test', async(
    event: Electron.IpcMainInvokeEvent,
    prompt: string,
    sessionId?: string,
  ): Promise<TestResult> => {
    const limactlPath = resolveLimactlPath({});
    const limaHome = resolveLimaHome({});

    // Pull Claude auth token from settings so we can set CLAUDE_CODE_OAUTH_TOKEN
    // inside the VM. `limactl shell --` runs non-interactive so /etc/claude-env
    // isn't sourced by .profile; we inject the env var explicitly via sh -c.
    const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
    const oauthToken = await SullaSettingsModel.get('claudeOAuthToken', '') ?? '';
    const apiKey = await SullaSettingsModel.get('claudeApiKey', '') ?? '';

    if (!oauthToken && !apiKey) {
      return {
        ok:       false,
        error:    'No Claude credentials configured. Sign in via Language Model Settings → Claude Code.',
        events:   0,
        text:     '',
        stderr:   '',
        exitCode: null,
      };
    }

    const envAssignments: string[] = [];
    if (oauthToken) envAssignments.push(`CLAUDE_CODE_OAUTH_TOKEN=${ JSON.stringify(oauthToken) }`);
    if (apiKey) envAssignments.push(`ANTHROPIC_API_KEY=${ JSON.stringify(apiKey) }`);

    // Build: env VAR=... claude -p "$PROMPT" --flags [--session-id X]
    const claudeArgs = [
      'claude',
      '-p', JSON.stringify(prompt),
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ];
    if (sessionId) {
      claudeArgs.push('--session-id', JSON.stringify(sessionId));
    }

    // Redirect stdin to /dev/null to silence "no stdin data received" warning
    const innerCmd = `${ envAssignments.join(' ') } ${ claudeArgs.join(' ') } < /dev/null`;
    const args = ['shell', '0', '--', 'sh', '-c', innerCmd];

    // Redacted log: don't write the OAuth token to disk.
    const redactedArgs = args.map((a) => a.replace(/CLAUDE_CODE_OAUTH_TOKEN="[^"]+"/g, 'CLAUDE_CODE_OAUTH_TOKEN=***')
      .replace(/ANTHROPIC_API_KEY="[^"]+"/g, 'ANTHROPIC_API_KEY=***'));
    console.log('[ClaudeTest] Spawning:', redactedArgs.join(' '));

    return await new Promise((resolve) => {
      const proc = childProcess.spawn(limactlPath, args, {
        env: {
          ...process.env,
          LIMA_HOME: limaHome,
          TERM:      'dumb',
        },
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let eventCount = 0;
      let capturedSessionId: string | undefined = sessionId;
      let textCollected = '';
      let completed = false;

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: StreamEvent;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          console.log(`[ClaudeTest][raw-non-json] ${ trimmed.slice(0, 300) }`);
          return;
        }

        eventCount++;
        if (parsed.session_id) capturedSessionId = parsed.session_id;

        // Summarize the event for logging
        const summary: Record<string, unknown> = { idx: eventCount, type: parsed.type };
        if (parsed.event?.type) summary.eventType = parsed.event.type;
        if (parsed.event?.content_block?.type) summary.blockType = parsed.event.content_block.type;
        if (parsed.event?.content_block?.name) summary.toolName = parsed.event.content_block.name;
        if (parsed.event?.delta?.type) summary.deltaType = parsed.event.delta.type;
        if (parsed.event?.delta?.text) {
          summary.textChars = parsed.event.delta.text.length;
          textCollected += parsed.event.delta.text;
        }
        if (parsed.event?.delta?.thinking) summary.thinkingChars = parsed.event.delta.thinking.length;
        if (parsed.subtype) summary.subtype = parsed.subtype;
        if (parsed.is_error) summary.isError = true;
        if (parsed.result) summary.hasResult = parsed.result.slice(0, 80);

        console.log(`[ClaudeTest][event] ${ JSON.stringify(summary) }`);

        // Forward to renderer (small payload)
        try {
          event.sender.send('claude-code:test:event', summary);
        } catch { /* window closed */ }

        // Also capture assistant completion result (non-streaming shape)
        if (parsed.type === 'result' && typeof parsed.result === 'string') {
          textCollected = parsed.result;
        }
      };

      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        stderrBuffer += text;
        // Stderr is usually warnings; log concisely.
        const trimmed = text.trim();
        if (trimmed) console.log(`[ClaudeTest][stderr] ${ trimmed.slice(0, 300) }`);
      });

      proc.on('error', (err) => {
        if (completed) return;
        completed = true;
        console.warn('[ClaudeTest] spawn error:', err);
        resolve({
          ok:       false,
          error:    `Failed to spawn: ${ err.message }`,
          events:   eventCount,
          text:     textCollected,
          stderr:   stderrBuffer,
          exitCode: null,
        });
      });

      proc.on('close', (code) => {
        if (completed) return;
        completed = true;
        // Flush any remaining buffered line
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

        console.log(`[ClaudeTest] exit code=${ code } events=${ eventCount } textChars=${ textCollected.length } sessionId=${ capturedSessionId ?? '(none)' }`);
        resolve({
          ok:        code === 0,
          sessionId: capturedSessionId,
          events:    eventCount,
          text:      textCollected,
          stderr:    stderrBuffer,
          exitCode:  code,
        });
      });
    });
  });
}
