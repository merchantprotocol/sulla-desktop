import { APP_REGISTRY } from '../../../main/computerUseSettings/appRegistry';
import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';

import { BaseTool, ToolResponse } from '../base';
import { broadcastComputerUseSettingsChanged } from './_broadcast';

/**
 * Flip off a Computer Use Settings target. Future applescript_execute
 * calls against this app will auto-re-enable it unless the user has
 * intentionally disabled it via the settings UI — so this tool is
 * primarily useful when the agent wants to clean up after itself or
 * respond to a "stop using X" request.
 */
export class ComputerUseDisableWorker extends BaseTool {
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

    if (!enabledApps[entry.bundleId]) {
      return { successBoolean: true, responseString: `${ entry.name } was already disabled.` };
    }

    delete enabledApps[entry.bundleId];
    await SullaSettingsModel.set('computerUse.enabledApps', JSON.stringify(enabledApps), 'string');
    broadcastComputerUseSettingsChanged();
    return { successBoolean: true, responseString: `Disabled ${ entry.name } (${ entry.bundleId }).` };
  }
}
