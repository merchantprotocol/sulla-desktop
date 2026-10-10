import { ChatArtifactTool } from './artifact_common';

export class ArtifactFocusWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().focus(this.threadId(), this.idOrName(input));
    return this.response('Focused artifact', artifact);
  }
}
