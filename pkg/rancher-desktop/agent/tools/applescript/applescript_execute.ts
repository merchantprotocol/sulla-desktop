import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * AppleScript Execute Tool — dynamically runs AppleScript to control
 * macOS applications that the user has enabled in Computer Use Settings.
 */
export class ApplescriptExecuteWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { target_app, script, action_type } = input;

    if (!target_app || !script) {
      return {
        successBoolean: false,
        responseString:  'Both target_app and script are required.',
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

    // ── Execute ─────────────────────────────────────────────────
    try {
      const res = await runCommand('osascript', ['-e', script], {
        timeoutMs:      10000,
        maxOutputChars: 100_000,
      });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString:  `AppleScript error: ${ res.stderr || res.stdout }`,
        };
      }

      const body = res.stdout.trim() || '(no output)';
      const prefix = autoEnabled ? `[Auto-enabled "${ target_app }" in Computer Use Settings.]\n` : '';
      return {
        successBoolean: true,
        responseString:  prefix + body,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString:  `Failed to execute AppleScript: ${ (error as Error).message }`,
      };
    }
  }
}
