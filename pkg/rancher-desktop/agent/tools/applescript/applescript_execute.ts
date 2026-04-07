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

    // ── Check enabled apps ──────────────────────────────────────
    try {
      const { SullaSettingsModel } = await import('../../database/models/SullaSettingsModel');
      const stored = await SullaSettingsModel.get('computerUse.enabledApps', '{}');
      const enabledApps: Record<string, boolean> = typeof stored === 'string' ? JSON.parse(stored) : (stored || {});

      const { APP_REGISTRY } = await import('../../../main/computerUseSettings/appRegistry');
      const appEntry = APP_REGISTRY.find(
        (a) => a.name.toLowerCase() === target_app.toLowerCase(),
      );

      if (!appEntry) {
        return {
          successBoolean: false,
          responseString:  `Unknown application: "${ target_app }". Check the app name and try again.`,
        };
      }

      if (!enabledApps[appEntry.bundleId]) {
        return {
          successBoolean: false,
          responseString:  `"${ target_app }" is not enabled in Computer Use Settings. Ask the user to enable it first.`,
        };
      }
    } catch (error) {
      return {
        successBoolean: false,
        responseString:  `Failed to check app permissions: ${ (error as Error).message }`,
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

      return {
        successBoolean: true,
        responseString:  res.stdout.trim() || '(no output)',
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString:  `Failed to execute AppleScript: ${ (error as Error).message }`,
      };
    }
  }
}
