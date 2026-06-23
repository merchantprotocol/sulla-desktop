import { BaseTool, ToolResponse } from '../base';
import { HOST_ACCESS_DISABLED_MESSAGE, isHostAccessEnabled } from '../util/hostAccess';
import { runCommand } from '../util/CommandRunner';
import { broadcastComputerUseSettingsChanged } from './_broadcast';

/** Terminal-emulator targets that give an agent a host shell. Driving these
 *  is "host machine access" and is gated by the application.hostAccess
 *  setting — unlike Mail/Notes/Calendar automation, which is not. */
const TERMINAL_EMULATOR_APPS = new Set(['terminal', 'iterm2', 'iterm']);

/**
 * Rewrite a Terminal `do script` bridge invocation so it (1) reuses a single
 * window instead of spawning a fresh one every call, and (2) does not steal
 * focus. Bare `do script "<cmd>"` always opens a NEW window; appending
 * `in window 1` (with an exists-guard) reuses the existing one. Stripping
 * `activate` keeps Terminal from jumping to the foreground / switching Spaces.
 */
export function rewriteTerminalScriptForReuse(script: string): string {
  let s = script;

  // Drop standalone `activate` lines so Terminal doesn't grab focus.
  s = s.replace(/^[ \t]*activate[ \t]*\r?\n/gim, '');

  // Match `do script "<quoted>"` only when it's the whole statement (no
  // existing `in <window/tab>` clause after the string), so we never touch
  // a command that already targets a window or one containing the word "in".
  const bareDoScript = /\bdo\s+script\s+("(?:[^"\\]|\\.)*")(\s*)(?=\r?\n|$)/gi;
  if (bareDoScript.test(s)) {
    bareDoScript.lastIndex = 0;
    s = s.replace(bareDoScript, 'do script $1 in window 1$2');
    // Ensure a window exists before we target `window 1`.
    s = s.replace(/(tell\s+application\s+"Terminal"\s*\r?\n)/i, '$1if (count of windows) is 0 then reopen\n');
  }

  return s;
}

/**
 * AppleScript Execute Tool — dynamically runs AppleScript to control
 * macOS applications that the user has enabled in Computer Use Settings.
 */
export class ApplescriptExecuteWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { target_app, script, action_type } = input;

    if (process.platform !== 'darwin') {
      return {
        successBoolean: false,
        responseString:  'AppleScript automation is only available on macOS.',
      };
    }

    if (!target_app || !script) {
      return {
        successBoolean: false,
        responseString:  'Both target_app and script are required.',
      };
    }

    // ── Host-access gate ────────────────────────────────────────
    // Driving a terminal emulator via osascript is a host shell escape.
    // Block it unless the user has enabled host machine access.
    if (TERMINAL_EMULATOR_APPS.has(String(target_app).toLowerCase()) && !isHostAccessEnabled()) {
      return {
        successBoolean: false,
        responseString:  HOST_ACCESS_DISABLED_MESSAGE,
      };
    }

    // ── Verify the app is a known AppleScript target, auto-enabling
    //    it if the user hasn't flipped it on yet. Agent-driven enable
    //    reflects implicit consent — the user asked us to do the thing
    //    ("connect to my mail"), so we enable and proceed. The toggle
    //    stays on for subsequent calls. Unknown apps still hard-fail.
    let autoEnabled = false;
    try {
      const { SullaSettingsModel } = await import('../../database/models/SullaSettingsModel');
      const { APP_REGISTRY } = await import('../../../main/computerUseSettings/appRegistry');

      const appEntry = APP_REGISTRY.find(
        (a) => a.name.toLowerCase() === target_app.toLowerCase(),
      );
      if (!appEntry) {
        return {
          successBoolean: false,
          responseString:  `Unknown application: "${ target_app }". Known targets: ${ APP_REGISTRY.map(a => a.name).join(', ') }.`,
        };
      }

      const stored = await SullaSettingsModel.get('computerUse.enabledApps', '{}');
      const enabledApps: Record<string, boolean> = typeof stored === 'string' ? JSON.parse(stored) : (stored || {});

      if (!enabledApps[appEntry.bundleId]) {
        enabledApps[appEntry.bundleId] = true;
        await SullaSettingsModel.set('computerUse.enabledApps', JSON.stringify(enabledApps), 'string');
        broadcastComputerUseSettingsChanged();
        autoEnabled = true;
      }
    } catch (error) {
      return {
        successBoolean: false,
        responseString:  `Failed to resolve app permissions: ${ (error as Error).message }`,
      };
    }

    // ── Sanitize script ─────────────────────────────────────────
    if (/do\s+shell\s+script/i.test(script)) {
      return {
        successBoolean: false,
        responseString:  'AppleScript containing "do shell script" is not allowed for security reasons.',
      };
    }

    const tellPattern = /tell\s+application\s+"([^"]+)"/gi;
    let match: RegExpExecArray | null;

    while ((match = tellPattern.exec(script)) !== null) {
      if (match[1].toLowerCase() !== target_app.toLowerCase()) {
        return {
          successBoolean: false,
          responseString:  `Script targets "${ match[1] }" but declared target is "${ target_app }". Each script must only target its declared app.`,
        };
      }
    }

    // ── Single-window / no-focus-steal rewrite for the Terminal bridge ──
    let effectiveScript = script;
    if (String(target_app).toLowerCase() === 'terminal') {
      effectiveScript = rewriteTerminalScriptForReuse(script);
    }

    // ── Execute ─────────────────────────────────────────────────
    const startedMs = Date.now();
    try {
      const res = await runCommand('osascript', ['-e', effectiveScript], {
        timeoutMs:      10000,
        maxOutputChars: 100_000,
      });

      if (res.exitCode !== 0) {
        const errBody = res.stderr || res.stdout;
        await writeAuditRow({ target_app, script, action_type, success: false, durationMs: Date.now() - startedMs, error: errBody, responseChars: errBody?.length ?? 0 });
        return {
          successBoolean: false,
          responseString:  `AppleScript error: ${ errBody }`,
        };
      }

      const body = res.stdout.trim() || '(no output)';
      await writeAuditRow({ target_app, script, action_type, success: true, durationMs: Date.now() - startedMs, responseChars: body.length });
      const prefix = autoEnabled ? `[Auto-enabled "${ target_app }" in Computer Use Settings.]\n` : '';
      return {
        successBoolean: true,
        responseString:  prefix + body,
      };
    } catch (error) {
      const msg = (error as Error).message;
      await writeAuditRow({ target_app, script, action_type, success: false, durationMs: Date.now() - startedMs, error: msg, responseChars: 0 });
      return {
        successBoolean: false,
        responseString:  `Failed to execute AppleScript: ${ msg }`,
      };
    }
  }
}

async function writeAuditRow(row: {
  target_app:    string;
  script:        string;
  action_type?:  string;
  success:       boolean;
  durationMs:    number;
  error?:        string;
  responseChars: number;
}): Promise<void> {
  try {
    const { postgresClient } = await import('../../database/PostgresClient');
    const actionType = row.action_type === 'write' ? 'write' : 'read';
    await postgresClient.query(
      `INSERT INTO applescript_audit
         (target_app, action_type, script, success, duration_ms, response_chars, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.target_app, actionType, row.script, row.success, row.durationMs, row.responseChars, row.error ?? null],
    );
  } catch (err) {
    // Audit failures must not break the tool call — just log.
    console.warn('[applescript audit] insert failed:', err);
  }
}
