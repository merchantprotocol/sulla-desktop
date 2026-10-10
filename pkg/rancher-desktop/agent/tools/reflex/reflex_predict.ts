import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { REFLEX_NONE } from '../../reflex/ReflexEngine';
import { getReflexEngine, getReflexSettings, getRouteReflexEngine, toolCategory } from '../../reflex/ReflexService';
import { reflexPolicyViolation } from '../../reflex/reflexPolicy';
import { BaseTool, ToolResponse } from '../base';

/** Dry-run the Reflex engine. Never executes anything. */
export class ReflexPredictWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const message = String(input.message ?? '');
    const [engine, routeEngine, settings, routeEnabledRaw] = await Promise.all([
      getReflexEngine(),
      getRouteReflexEngine(),
      getReflexSettings(),
      SullaSettingsModel.get('reflexRouteEnabled', 'true'),
    ]);
    const p = engine.predict(message);
    const route = routeEngine.predict(message);
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
        route:      {
          enabled:     String(routeEnabledRaw) !== 'false',
          would_route: String(routeEnabledRaw) !== 'false' && route.toolName === 'route_agent' && route.confidence >= settings.threshold,
          agent_id:    typeof route.params?.agentId === 'string' ? route.params.agentId : null,
          confidence:  route.confidence,
          threshold:   settings.threshold,
          support:     route.support,
          reason:      route.reason,
          neighbours:  route.neighbours,
          examples:    routeEngine.size,
        },
      }, null, 2),
    };
  }
}
