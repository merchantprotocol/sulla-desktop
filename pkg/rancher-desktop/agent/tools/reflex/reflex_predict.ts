import { reflexPolicyViolation } from '../../reflex/reflexPolicy';
import { REFLEX_NONE } from '../../reflex/ReflexEngine';
import { getReflexEngine, getReflexSettings, toolCategory } from '../../reflex/ReflexService';
import { BaseTool, ToolResponse } from '../base';

/** Dry-run the Reflex engine. Never executes anything. */
export class ReflexPredictWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const message = String(input.message ?? '');
    const [engine, settings] = await Promise.all([getReflexEngine(), getReflexSettings()]);
    const p = engine.predict(message);
    const violation = p.toolName === REFLEX_NONE
      ? null
      : reflexPolicyViolation({ toolName: p.toolName, category: toolCategory(p.toolName), params: p.params, allowedCategories: settings.allowedCategories });
    const wouldAct = settings.enabled && p.toolName !== REFLEX_NONE && p.confidence >= settings.threshold && !violation;
    return {
      successBoolean: true,
      responseString: JSON.stringify({
        would_act:  wouldAct,
        tool:       p.toolName,
        params:     p.params,
        confidence: p.confidence,
        threshold:  settings.threshold,
        support:    p.support,
        reason:     violation ?? p.reason,
        neighbours: p.neighbours,
        examples:   engine.size,
      }, null, 2),
    };
  }
}
