import type { ReflexExampleRow } from '../../database/models/ReflexModel';
import { announceReflexLearned } from '../../reflex/reflexLearnedNotice';
import { teachExample, type RawExample } from '../../reflex/reflexTraining';
import { BaseTool, ToolResponse } from '../base';

/** Adds Reflex training examples (single or bulk). */
export class ReflexTeachWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const batch: RawExample[] = Array.isArray(input.examples) && input.examples.length
      ? input.examples
      : [{ utterance: input.utterance, tool: input.tool, params: input.params, positive: input.positive }];
    const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'model';
    const threadId = (this.state as any)?.metadata?.parentConversationId ?? (this.state as any)?.metadata?.threadId ?? null;

    const lines: string[] = [];
    const created: ReflexExampleRow[] = [];
    let added = 0;
    let refreshed = 0;
    let rejected = 0;
    for (const [i, raw] of batch.entries()) {
      try {
        const res = await teachExample(raw, { source, threadId });
        if (res.ok) {
          if (res.created) { added++; created.push(res.row) } else refreshed++;
          lines.push(`✓ [${ res.row.id }] "${ res.row.utterance }" → ${ res.row.positive ? '' : 'NOT ' }${ res.row.tool_name } ${ JSON.stringify(res.row.params) }${ res.created ? '' : ' (already known)' }`);
        } else {
          rejected++;
          lines.push(`✗ #${ i + 1 }: ${ res.error }`);
        }
      } catch (err: any) {
        rejected++;
        lines.push(`✗ #${ i + 1 }: ${ err?.message ?? err }`);
      }
    }
    await announceReflexLearned(this.state, created, { source, batchSize: batch.length });
    return {
      successBoolean: added + refreshed > 0,
      responseString: `Reflex training: ${ added } added, ${ refreshed } already known, ${ rejected } rejected.\n${ lines.join('\n') }`,
    };
  }
}
