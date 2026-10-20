import { ChatArtifactTool } from './artifact_common';

export class ArtifactOpenWorker extends ChatArtifactTool {
  protected async _validatedCall(input: any) {
    const result = await this.service().openFile(this.threadId(), String(input.file_id ?? ''), input.focus !== false);
    return this.response(result.created ? 'Opened Files file as artifact' : 'Focused existing file artifact', result.artifact, true);
  }
}
