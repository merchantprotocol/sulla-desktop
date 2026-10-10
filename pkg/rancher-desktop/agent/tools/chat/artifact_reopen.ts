import { ChatArtifactTool } from './artifact_common';

export class ArtifactReopenWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().reopen(this.threadId(), this.idOrName(input), this.expectedVersion(input), 'agent');
    return this.response('Reopened artifact', artifact);
  }
}
