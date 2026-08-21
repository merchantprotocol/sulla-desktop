import { ConversationKeywordsModel, ConversationKeywordSource } from '../../database/models/ConversationKeywordsModel';
import { BaseTool, ToolResponse } from '../base';

export class UpsertConversationKeywordsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const rows = await ConversationKeywordsModel.upsertMany({
        terms: input.terms,
        thread_id: input.thread_id,
        conversation_history_id: input.conversation_history_id,
        channel_id: input.channel_id,
        agent_id: input.agent_id,
        source: input.source as ConversationKeywordSource | undefined,
      });
      return { successBoolean: true, responseString: `Indexed ${ rows.length } canonical conversation keyword(s) for thread ${ input.thread_id }.` };
    } catch (error: any) {
      return { successBoolean: false, responseString: `Failed to index conversation keywords: ${ error?.message || error }` };
    }
  }
}
