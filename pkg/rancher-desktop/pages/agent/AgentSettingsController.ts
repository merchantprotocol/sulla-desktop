import type { Ref } from 'vue';
import { getAgentPersonaRegistry } from '@pkg/agent';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

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
    this.modelMode.value = await SullaSettingsModel.get('modelMode', 'local');

    if (this.modelMode.value === 'remote') {
      this.modelName.value = await SullaSettingsModel.get('remoteModel', 'grok-4-1-fast-reasoning');
      console.log(`[Agent] Remote model configured: ${ await SullaSettingsModel.get('remoteProvider', 'grok') }/${ this.modelName.value }`);
    } else {
      this.modelName.value = await SullaSettingsModel.get('sullaModel', 'tinyllama:latest');
      console.log(`[Agent] Local model configured: ${ this.modelName.value }`);
    }
  }
}
