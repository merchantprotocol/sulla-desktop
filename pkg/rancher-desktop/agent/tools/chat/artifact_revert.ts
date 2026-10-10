import { ChatArtifactTool } from './artifact_common';

export class ArtifactRevertWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifact = await this.service().revert(
      this.threadId(), this.idOrName(input), Number(input.version),
      this.expectedVersion(input), 'agent',
    );
    return this.response(`Reverted artifact to version ${ input.version } as a new revision`, artifact, true);
  }
}
