import { APP_REGISTRY } from '../../../main/computerUseSettings/appRegistry';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';

import { BaseTool, ToolResponse } from '../base';

/**
 * List every AppleScript target the user's Computer Use Settings
 * exposes, annotated with its current enabled/disabled state. The
 * agent uses this to discover what targets exist before calling
 * applescript_execute (which will auto-enable on the fly anyway).
 */
export class ComputerUseListWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    const stored = await SullaSettingsModel.get('computerUse.enabledApps', '{}');
    const enabledApps: Record<string, boolean> = typeof stored === 'string' ? JSON.parse(stored) : (stored || {});

    // Group by category for a readable listing.
    const byCat = new Map<string, { name: string; bundleId: string; enabled: boolean; description: string }[]>();
    for (const a of APP_REGISTRY) {
      const arr = byCat.get(a.category) ?? [];
      arr.push({
        name:        a.name,
        bundleId:    a.bundleId,
        enabled:     !!enabledApps[a.bundleId],
        description: a.description,
      });
      byCat.set(a.category, arr);
    }

    const lines: string[] = [`${ APP_REGISTRY.length } AppleScript targets:\n`];
    for (const [cat, items] of byCat) {
      lines.push(`## ${ cat }`);
      for (const i of items) {
        const flag = i.enabled ? '✓' : '·';
        lines.push(`  ${ flag } **${ i.name }** (${ i.bundleId }) — ${ i.description }`);
      }
      lines.push('');
    }

    return { successBoolean: true, responseString: lines.join('\n') };
  }
}
