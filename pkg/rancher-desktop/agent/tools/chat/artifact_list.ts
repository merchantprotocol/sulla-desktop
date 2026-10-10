import { ChatArtifactTool } from './artifact_common';

export class ArtifactListWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const artifacts = await this.service().list(this.threadId(), !!input.includeClosed);
    const body = artifacts.length
      ? artifacts.map(a => `${ a.id } | ${ a.name } | ${ a.kind } | ${ a.status } | v${ a.version } | ${ a.isOpen ? 'open' : 'closed' } | ${ a.updatedAt }`).join('\n')
      : 'No artifacts found for this chat.';
    return { successBoolean: true, responseString: body };
  }
}
