import { ChatArtifactTool } from './artifact_common';

export class ArtifactCreateWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const result = await this.service().create(this.threadId(), {
      name: input.name,
      kind: input.kind,
      content: input.content,
      status: input.status,
      language: input.language,
      path: input.path,
      author: 'agent',
      focus: input.focus !== false,
      expectedVersion: this.expectedVersion(input),
    });
    return this.response(result.created ? 'Created artifact' : 'Updated existing artifact with the same name', result.artifact, true);
  }
}
