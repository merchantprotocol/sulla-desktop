import { ChatArtifactTool } from './artifact_common';

export class ArtifactCloseWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().close(this.threadId(), this.idOrName(input), this.expectedVersion(input), 'agent');
    return this.response('Closed artifact', artifact);
  }
}
