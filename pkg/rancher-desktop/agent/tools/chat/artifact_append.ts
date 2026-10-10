import { ChatArtifactTool } from './artifact_common';

export class ArtifactAppendWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().append(
      this.threadId(), this.idOrName(input), input.text,
      this.expectedVersion(input), 'agent',
    );
    return this.response('Appended to artifact', artifact, true);
  }
}
