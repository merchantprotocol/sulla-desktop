import { ChatArtifactTool } from './artifact_common';

export class ArtifactHistoryWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const threadId = this.threadId();
    const idOrName = this.idOrName(input);
    const [artifact, revisions] = await Promise.all([
      this.service().get(threadId, idOrName),
      this.service().history(threadId, idOrName),
    ]);
    const body = revisions.map(r => `version ${ r.version } | ${ r.author } | ${ r.createdAt }\n${ r.content }`).join('\n\n---\n\n');
    return {
      successBoolean: true,
      responseString: `History: ${ artifact.name }\nid: ${ artifact.id }\ncurrent version: ${ artifact.version }\n\n${ body || 'No revisions found.' }`,
    };
  }
}
