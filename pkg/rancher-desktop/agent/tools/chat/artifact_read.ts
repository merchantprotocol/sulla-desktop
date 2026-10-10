import { ChatArtifactTool } from './artifact_common';

export class ArtifactReadWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().get(this.threadId(), this.idOrName(input));
    return this.response('Artifact', artifact, true);
  }
}
