// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getAgentPersonaRegistry } from '@pkg/agent';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

import type { Ref } from 'vue';

export class AgentSettingsController {
  private readonly registry = getAgentPersonaRegistry();

  constructor(
    private readonly params: {
      modelName: Ref<string>;
      modelMode: Ref<'local' | 'remote'>;
    },
  ) {
    this.modelName = params.modelName;
    this.modelMode = params.modelMode;
  }

  private modelName: Ref<string>;
  private modelMode: Ref<'local' | 'remote'>;

  async start(): Promise<void> {
    // Fetch initial settings from SullaSettingsModel
    // Sulla only runs provider models (API key / sign-in, or a user-run Ollama server).
    this.modelMode.value = 'remote';
    this.modelName.value = await SullaSettingsModel.get('remoteModel', 'grok-4-1-fast-reasoning');
    console.log(`[Agent] Model configured: ${ await SullaSettingsModel.get('remoteProvider', '') }/${ this.modelName.value }`);
  }
}
