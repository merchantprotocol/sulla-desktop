/**
 * ReflexService — runs the Reflex decision engine in front of the language
 * model on fresh human turns.
 *
 * Flow per turn (AgentNode, before subconscious recall):
 *   1. predict(user message) against the Postgres-backed training set
 *   2. if confidence ≥ reflexConfidenceThreshold and the policy allows the
 *      tool, execute it immediately through the normal tool registry
 *   3. record a receipt in reflex_decisions and hand the language model a
 *      <reflex_context> block describing what already happened
 *
 * Below threshold nothing runs — the model handles the message as usual and
 * the post-turn Reflex Trainer learns from what the model did.
 */

import { ReflexModel } from '../database/models/ReflexModel';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { toolRegistry } from '../tools/registry';

import { REFLEX_NONE, ReflexEngine, type ReflexPrediction } from './ReflexEngine';
import { parseCategories, reflexPolicyViolation } from './reflexPolicy';

export const DEFAULT_REFLEX_THRESHOLD = 0.85;

export interface ReflexTurnResult {
  decisionId: string;
  toolName:   string;
  params:     Record<string, unknown>;
  confidence: number;
  success:    boolean;
  summary:    string;
}

export interface ReflexSettings {
  enabled:           boolean;
  threshold:         number;
  allowedCategories: string[];
}

let engine: ReflexEngine | null = null;
let engineVersion = -1;

export async function getReflexSettings(): Promise<ReflexSettings> {
  const [enabled, threshold, categories] = await Promise.all([
    SullaSettingsModel.get('reflexEnabled', 'true'),
    SullaSettingsModel.get('reflexConfidenceThreshold', String(DEFAULT_REFLEX_THRESHOLD)),
    SullaSettingsModel.get('reflexAllowedCategories', ''),
  ]);
  const parsed = Number(threshold);
  return {
    enabled:           String(enabled) !== 'false',
    threshold:         Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_REFLEX_THRESHOLD,
    allowedCategories: parseCategories(categories),
  };
}

/** Engine trained on the current example set; retrains only after writes. */
export async function getReflexEngine(): Promise<ReflexEngine> {
  if (!engine || engineVersion !== ReflexModel.version) {
    const version = ReflexModel.version;
    const examples = await ReflexModel.activeExamples();
    engine = new ReflexEngine(examples);
    engineVersion = version;
  }
  return engine;
}

export function toolCategory(toolName: string): string | undefined {
  for (const category of toolRegistry.getCategories()) {
    if (toolRegistry.getToolNamesForCategory(category).includes(toolName)) return category;
  }
  return undefined;
}

export async function predictReflex(message: string): Promise<ReflexPrediction> {
  return (await getReflexEngine()).predict(message);
}

/**
 * Decide and (maybe) act. Never throws — reflex failures must never block
 * the model turn.
 */
export async function runReflex(message: string, state: any): Promise<ReflexTurnResult | null> {
  try {
    const settings = await getReflexSettings();
    if (!settings.enabled || !message.trim()) return null;

    const prediction = await predictReflex(message);
    if (prediction.toolName === REFLEX_NONE) return null;

    const threadId = state?.metadata?.threadId ?? null;
    const base = {
      thread_id:  threadId,
      utterance:  message.slice(0, 2000),
      tool_name:  prediction.toolName,
      params:     prediction.params,
      confidence: prediction.confidence,
    };

    if (prediction.confidence < settings.threshold) {
      await ReflexModel.recordDecision({ ...base, status: 'below_threshold', result: prediction.reason });
      return null;
    }

    const violation = reflexPolicyViolation({
      toolName:          prediction.toolName,
      category:          toolCategory(prediction.toolName),
      params:            prediction.params,
      allowedCategories: settings.allowedCategories,
    });
    const { decisionService } = await import('../services/DecisionService');
    const blockedReason = violation ?? (await decisionService.requiresApproval(prediction.toolName) ? 'tool requires human approval' : null);
    if (blockedReason) {
      await ReflexModel.recordDecision({ ...base, status: 'blocked', result: blockedReason });
      return null;
    }

    const tool = await toolRegistry.createTool(prediction.toolName);
    const result = await tool.invoke(prediction.params, state);
    const success = !!result?.success;
    const detail = String(success ? (result?.result ?? '') : (result?.error ?? result?.result ?? 'unknown error'));
    const summary = detail.slice(0, 600);
    const decisionId = await ReflexModel.recordDecision({ ...base, status: success ? 'acted' : 'failed', result: summary });

    return { decisionId, toolName: prediction.toolName, params: prediction.params, confidence: prediction.confidence, success, summary };
  } catch (err) {
    console.warn('[Reflex] decision failed; handing the turn to the model untouched:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Body of the <reflex_context> block the language model sees (BaseNode adds
 * the tags) so it does not repeat — or can correct — the reflex action.
 */
export function formatReflexContext(r: ReflexTurnResult): string {
  const outcome = r.success ? 'succeeded' : 'FAILED';
  return [
    `Before you saw this message, Sulla's Reflex engine already ran ${ r.toolName } ${ JSON.stringify(r.params) } (confidence ${ r.confidence }) and it ${ outcome }.`,
    `Result: ${ r.summary || '(no output)' }`,
    r.success
      ? 'Do not repeat this action. If it was the wrong action for the message, fix it yourself and call reflex_correct with decision_id ' + r.decisionId + ' (plus the correct tool/params if you know them).'
      : 'The action failed; handle the request yourself. If the reflex picked the wrong action, call reflex_correct with decision_id ' + r.decisionId + '.',
  ].join('\n');
}

/** Plain text of the latest human message, or '' when the turn is not a fresh human message. */
export function latestHumanText(messages: any[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || last.metadata?.source === 'subconscious') return '';
  const text = typeof last.content === 'string'
    ? last.content
    : Array.isArray(last.content)
      ? last.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
      : '';
  return text.replace(/<turn_context>[\s\S]*?<\/turn_context>/g, '').trim();
}
