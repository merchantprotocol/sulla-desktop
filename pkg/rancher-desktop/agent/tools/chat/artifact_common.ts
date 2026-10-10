import { getChatArtifactService } from '../../services/ChatArtifactService';
import { BaseTool, type ToolResponse } from '../base';

import type { ChatArtifactRecord } from '@pkg/shared/chatArtifacts';

export abstract class ChatArtifactTool extends BaseTool {
  name = '';
  description = '';

  protected threadId(): string {
    const threadId = String(this.state?.metadata?.threadId || '').trim();
    if (!threadId) throw new Error('Artifact tools must be called from a chat thread.');
    return threadId;
  }

  protected idOrName(input: any): string {
    const value = String(input.idOrName ?? input.id ?? input.name ?? '').trim();
    if (!value) throw new Error('Artifact id or name is required.');
    return value;
  }

  protected expectedVersion(input: any): number | undefined {
    return input.expectedVersion === undefined ? undefined : Number(input.expectedVersion);
  }

  protected service() {
    return getChatArtifactService();
  }

  protected response(action: string, artifact: ChatArtifactRecord, includeContent = false): ToolResponse {
    const lines = [
      `${ action }: ${ artifact.name }`,
      `id: ${ artifact.id }`,
      `kind: ${ artifact.kind }`,
      `status: ${ artifact.status }`,
      `version: ${ artifact.version }`,
    ];
    if (includeContent) lines.push('content:', artifact.content);
    return { successBoolean: true, responseString: lines.join('\n') };
  }
}
