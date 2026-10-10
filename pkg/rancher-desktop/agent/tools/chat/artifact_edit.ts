import { ChatArtifactTool } from './artifact_common';

export class ArtifactEditWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().edit(
      this.threadId(), this.idOrName(input), input.edits,
      this.expectedVersion(input), 'agent',
    );
    return this.response('Edited artifact', artifact, true);
  }
}
