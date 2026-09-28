import { ReflexModel } from '../../database/models/ReflexModel';
import { teachExample } from '../../reflex/reflexTraining';
import { BaseTool, ToolResponse } from '../base';

/** Marks a Reflex decision wrong and (optionally) teaches the right answer. */
export class ReflexCorrectWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const decision = await ReflexModel.getDecision(String(input.decision_id ?? '').trim());
    if (!decision) return { successBoolean: false, responseString: `No reflex decision found with id: ${ input.decision_id }` };

    const threadId = decision.thread_id;
    const lines: string[] = [];
    const negative = await teachExample(
      { utterance: decision.utterance, tool: decision.tool_name, params: decision.params, positive: false },
      { source: 'correction', threadId },
    );
    lines.push(negative.ok ? `Recorded: do NOT run ${ decision.tool_name } for "${ decision.utterance.slice(0, 120) }".` : `Counter-example failed: ${ negative.error }`);

    if (typeof input.tool === 'string' && input.tool.trim()) {
      const positive = await teachExample(
        { utterance: decision.utterance, tool: input.tool, params: input.params, positive: true },
        { source: 'correction', threadId },
      );
      lines.push(positive.ok ? `Taught instead: ${ positive.row.tool_name } ${ JSON.stringify(positive.row.params) }.` : `Correct action not taught: ${ positive.error }`);
    }
    await ReflexModel.markCorrected(decision.id);
    return { successBoolean: negative.ok, responseString: lines.join('\n') };
  }
}
