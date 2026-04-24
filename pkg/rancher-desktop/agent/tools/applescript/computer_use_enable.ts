import { APP_REGISTRY } from '../../../main/computerUseSettings/appRegistry';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';

import { BaseTool, ToolResponse } from '../base';
import { broadcastComputerUseSettingsChanged } from './_broadcast';

/**
 * Flip on a Computer Use Settings target so subsequent applescript_execute
 * calls (and the settings UI) see it as enabled. Matches by app name or
 * bundleId. No-op if already enabled.
 */
export class ComputerUseEnableWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const target = String(input.app || input.bundleId || '').trim();
    if (!target) {
      return { successBoolean: false, responseString: 'app (name or bundleId) is required.' };
    }

    const entry = APP_REGISTRY.find(
      a => a.name.toLowerCase() === target.toLowerCase() || a.bundleId.toLowerCase() === target.toLowerCase(),
    );
    if (!entry) {
      return {
        successBoolean: false,
        responseString: `Unknown application: "${ target }". Run applescript/computer_use_list to see every target.`,
      };
    }

    const stored = await SullaSettingsModel.get('computerUse.enabledApps', '{}');
    const enabledApps: Record<string, boolean> = typeof stored === 'string' ? JSON.parse(stored) : (stored || {});

    if (enabledApps[entry.bundleId]) {
      return { successBoolean: true, responseString: `${ entry.name } was already enabled.` };
    }

    enabledApps[entry.bundleId] = true;
    await SullaSettingsModel.set('computerUse.enabledApps', JSON.stringify(enabledApps), 'string');
    broadcastComputerUseSettingsChanged();
    return { successBoolean: true, responseString: `Enabled ${ entry.name } (${ entry.bundleId }).` };
  }
}
