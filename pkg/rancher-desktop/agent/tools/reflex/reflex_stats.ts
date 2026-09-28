import { ReflexModel } from '../../database/models/ReflexModel';
import { getReflexSettings } from '../../reflex/ReflexService';
import { BaseTool, ToolResponse } from '../base';

export class ReflexStatsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const [settings, stats, recent] = await Promise.all([
      getReflexSettings(),
      ReflexModel.stats(),
      ReflexModel.recentDecisions(typeof input.recent === 'number' ? input.recent : 10),
    ]);
    return {
      successBoolean: true,
      responseString: JSON.stringify({
        settings,
        ...stats,
        recent: recent.map(d => ({
          id: d.id, at: d.created_at, message: d.utterance.slice(0, 160), tool: d.tool_name, params: d.params,
          confidence: d.confidence, status: d.status, corrected: d.corrected, result: d.result?.slice(0, 200),
        })),
      }, null, 2),
    };
  }
}
