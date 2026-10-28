// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';

import { getWindow, openDocker, openPreferences } from '@pkg/window';

/**
 * UI Open Tab — bridge between the agent and the renderer's `agent-command`
 * IPC handler. Lets the agent open / focus a built-in app view (use-cases,
 * vault, integrations, routines, history, secretary, chat, etc.) from chat.
 *
 * The renderer's `onAgentCommand` handler in pages/AgentRouter.vue already
 * accepts `{ command: 'open-tab', mode }` and `{ command: 'open-url', url }`
 * shapes — this tool just dispatches them to the main-agent window.
 *
 * For extension web UIs (Twenty CRM, etc.), prefer `browser/tab` with the
 * extension's URL — those aren't built-in modes.
 */

// The renderer still keys that view as `marketplace`; all three public names
// remain accepted for backwards compatibility.
const MODE_ALIASES: Record<string, string> = { 'use-cases': 'marketplace', packages: 'marketplace' };

const VALID_MODES = new Set([
  'chat',
  'use-cases',
  'packages',
  'marketplace',
  'integrations',
  'vault',
  'routines',
  'history',
  'secretary',
  'document',
  'browser',
  'welcome',
  'agents',
  'files',
  'decide',
]);

export class UiOpenTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    const mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';

    const section = typeof input.section === 'string' ? input.section.trim() : '';

    // Preferences and Docker are single tabs that open on a section. `settings`,
    // `models` and `audio` are the older names for Preferences and two of its sections.
    const SECTION_TABS: Record<string, { open: () => void; label: string }> = {
      preferences: { open: () => openPreferences(section), label: section ? `Preferences › ${ section }` : 'Preferences' },
      settings:    { open: () => openPreferences(section), label: section ? `Preferences › ${ section }` : 'Preferences' },
      models:      { open: () => openPreferences('models'), label: 'Preferences › AI models' },
      audio:       { open: () => openPreferences('voice'), label: 'Preferences › Voice & audio' },
      docker:      { open: () => openDocker(section), label: section ? `Docker › ${ section }` : 'Docker' },
    };
    if (SECTION_TABS[mode]) {
      try {
        SECTION_TABS[mode].open();
        return { successBoolean: true, responseString: `Opened the ${ SECTION_TABS[mode].label } tab.` };
      } catch (err) {
        return { successBoolean: false, responseString: `Failed to open ${ SECTION_TABS[mode].label }: ${ (err as Error).message }` };
      }
    }

    // If only a URL is given, route as open-url (raw browser tab on that URL).
    if (url && !mode) {
      const sent = sendToAgentWindow({ command: 'open-url', url });
      if (!sent) {
        return {
          successBoolean: false,
          responseString: 'Main agent window not available — Sulla Desktop UI may not be ready yet.',
        };
      }
      return {
        successBoolean: true,
        responseString: `Opened browser tab on ${ url }.`,
      };
    }

    if (!mode) {
      return {
        successBoolean: false,
        responseString: `Missing required field: mode. Valid modes: ${ Array.from(VALID_MODES).join(', ') }, preferences, settings, models, audio, docker. (Or pass a "url" to open a raw browser tab.)`,
      };
    }

    if (!VALID_MODES.has(mode)) {
      return {
        successBoolean: false,
        responseString: `Unknown tab mode "${ mode }". Valid modes: ${ Array.from(VALID_MODES).join(', ') }, preferences, settings, models, audio, docker.`,
      };
    }

    const sent = sendToAgentWindow({ command: 'open-tab', mode: MODE_ALIASES[mode] ?? mode });
    if (!sent) {
      return {
        successBoolean: false,
        responseString: 'Main agent window not available — Sulla Desktop UI may not be ready yet.',
      };
    }

    return {
      successBoolean: true,
      responseString: `Opened "${ mode }" tab in Sulla Desktop.`,
    };
  }
}

function sendToAgentWindow(payload: Record<string, unknown>): boolean {
  const agentWindow = getWindow('main-agent');
  if (!agentWindow) return false;

  const dispatch = () => agentWindow.webContents.send('agent-command', payload);

  if (agentWindow.webContents.isLoading()) {
    agentWindow.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }

  agentWindow.focus();
  return true;
}
