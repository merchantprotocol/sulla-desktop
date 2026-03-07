/**
 * Node handler registry — one handler function per WorkflowNodeSubtype.
 *
 * Each handler receives typed args and returns a result that the executor
 * stores in the shared WorkflowExecutionContext.
 */

import type { WorkflowNodeSubtype } from '@pkg/pages/editor/workflow/types';
import type { NodeHandler, NodeOutput, WorkflowExecutionContext } from './types';

// ── Handler implementations ──

/**
 * Trigger nodes are entry points — they simply pass through the trigger payload.
 */
const triggerHandler: NodeHandler = async({ context }) => {
  return { result: context.triggerPayload };
};

/**
 * Agent node — spawns a full AgentGraph, runs to completion, captures output.
 * Uses the existing GraphRegistry + createAgentGraph() infrastructure.
 */
/**
 * Resolve {{variable}} templates against the execution context.
 * Supports: {{trigger.result}}, {{NodeLabel.result}}, {{NodeLabel.threadId}}
 */
function resolveTemplate(template: string, context: WorkflowExecutionContext, upstreamOutputs: NodeOutput[]): string {
  return template.replace(/\{\{(\s*[\w\-. ]+\s*)\}\}/g, (_match, expr: string) => {
    const parts = expr.trim().split('.');
    const name = parts[0];
    const field = parts[1] || 'result';

    // {{trigger.result}}
    if (name === 'trigger') {
      const payload = context.triggerPayload;
      return typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    }

    // Find matching upstream output by label or nodeId
    const output = upstreamOutputs.find(o => o.label === name || o.nodeId === name)
      ?? Array.from(context.nodeOutputs.values()).find(o => o.label === name || o.nodeId === name);

    if (!output) return _match; // leave unresolved tokens as-is

    if (field === 'threadId') return output.threadId ?? '';
    if (field === 'result') {
      return typeof output.result === 'string' ? output.result : JSON.stringify(output.result ?? '');
    }

    return _match;
  });
}

const agentHandler: NodeHandler = async(args) => {
  const { nodeId, config, context, upstreamOutputs, abortSignal } = args;

  const agentId = (config.agentId as string) || '';
  const additionalPrompt = (config.additionalPrompt as string) || '';
  const userMessageTemplate = (config.userMessage as string) || '';

  // If userMessage template is provided, resolve it; otherwise fall back to legacy behavior
  let prompt: string;
  if (userMessageTemplate.trim()) {
    prompt = resolveTemplate(userMessageTemplate, context, upstreamOutputs);
    if (additionalPrompt) {
      prompt = `${additionalPrompt}\n\n${prompt}`;
    }
  } else {
    // Legacy: build prompt from upstream outputs + additional prompt
    const upstreamContext = upstreamOutputs
      .map(o => `[${o.label}]: ${typeof o.result === 'string' ? o.result : JSON.stringify(o.result)}`)
      .join('\n\n');

    prompt = [
      additionalPrompt,
      upstreamContext ? `\nUpstream context:\n${upstreamContext}` : '',
      typeof context.triggerPayload === 'string' && upstreamOutputs.length === 0
        ? context.triggerPayload
        : '',
    ].filter(Boolean).join('\n');
  }

  // Dynamic imports to avoid bundling main-process modules into renderer
  const { GraphRegistry } = await import('@pkg/agent/services/GraphRegistry');

  const threadId = `workflow-${context.executionId}-${nodeId}`;
  // Use the agentId to load the correct agent config, but route responses
  // back to the originating channel (e.g. 'sulla-desktop') so the frontend sees them
  const agentConfigChannel = agentId || threadId;
  const wsChannel = context.originChannel || agentConfigChannel;

  console.log(`[WorkflowAgent] agentId="${agentId}", agentConfigChannel="${agentConfigChannel}", wsChannel="${wsChannel}", originChannel="${context.originChannel}", threadId="${threadId}"`);

  const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(agentConfigChannel, threadId) as {
    graph: any;
    state: any;
  };

  console.log(`[WorkflowAgent] Agent config loaded: name="${state.metadata?.agent?.name || '(none)'}", hasPrompt=${!!state.metadata?.agent?.prompt}`);

  // Inject the prompt as a user message
  state.messages.push({
    role:    'user',
    content: prompt,
  });

  // Wire abort signal and route responses to the ORIGINAL frontend channel
  if (state.metadata) {
    state.metadata.abortSignal = abortSignal;
    state.metadata.wsChannel = wsChannel;
  }

  // Execute the agent graph
  const finalState = await graph.execute(state);

  return {
    result:   finalState.metadata?.finalSummary || finalState.messages?.[finalState.messages.length - 1]?.content || '',
    threadId,
  };
};

/**
 * Tool Call node — executes a YAML-configured integration API call.
 * Resolves {{variable}} templates in parameter defaults, then calls
 * the existing ConfigApiClient infrastructure.
 */
const toolCallHandler: NodeHandler = async(args) => {
  const { config, context, upstreamOutputs } = args;

  const integrationSlug = (config.integrationSlug as string) || '';
  const endpointName = (config.endpointName as string) || '';
  const accountId = (config.accountId as string) || 'default';
  const defaults = (config.defaults as Record<string, string>) || {};

  if (!integrationSlug || !endpointName) {
    return { result: { error: 'Missing integration or endpoint configuration' } };
  }

  // Resolve {{variable}} templates in parameter defaults
  const params: Record<string, any> = {};
  for (const [key, value] of Object.entries(defaults)) {
    params[key] = resolveTemplate(value, context, upstreamOutputs);
  }

  // Load the integration client
  const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
  const loader = getIntegrationConfigLoader();
  const client = loader.getClient(integrationSlug);

  if (!client) {
    return { result: { error: `Integration "${integrationSlug}" not found or not loaded` } };
  }

  // Resolve credentials from IntegrationService
  const options: Record<string, any> = {};
  try {
    const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
    const integrationService = getIntegrationService();
    const values = await integrationService.getFormValues(integrationSlug, accountId);
    const apiKeyVal = values.find((v: { property: string; value: string }) =>
      v.property === 'api_key' || v.property === 'apiKey' || v.property === 'token',
    );
    if (apiKeyVal?.value) {
      options.apiKey = apiKeyVal.value;
    }
    const tokenVal = values.find((v: { property: string; value: string }) => v.property === 'access_token');
    if (tokenVal?.value) {
      options.token = tokenVal.value;
    }
  } catch (err) {
    console.warn('[ToolCallHandler] Could not load credentials:', err);
  }

  const result = await client.call(endpointName, params, options);

  return { result };
};

/**
 * Router node — uses LLM to classify input into one of the configured routes.
 * Returns the selected route handle so the executor follows the correct edge.
 */
const routerHandler: NodeHandler = async(args) => {
  const { config, upstreamOutputs, abortSignal } = args;

  const classificationPrompt = (config.classificationPrompt as string) || '';
  const routes = (config.routes as Array<{ label: string; description: string }>) || [];

  if (routes.length === 0) {
    return { result: 'no routes configured', selectedHandle: undefined };
  }

  // Build the classification prompt
  const routeDescriptions = routes
    .map((r, i) => `${i + 1}. "${r.label}": ${r.description}`)
    .join('\n');

  const inputText = upstreamOutputs
    .map(o => typeof o.result === 'string' ? o.result : JSON.stringify(o.result))
    .join('\n');

  const systemPrompt = `You are a classifier. Given the input, classify it into exactly one of these categories.
Respond with ONLY the category label, nothing else.

Categories:
${routeDescriptions}

${classificationPrompt ? `Additional instructions: ${classificationPrompt}` : ''}`;

  const { getLLMService } = await import('@pkg/agent/languagemodels');
  const llm = await getLLMService('remote');

  const response = await llm.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: inputText || '(empty input)' },
    ],
    { signal: abortSignal },
  );

  const rawContent = typeof response === 'string' ? response : (response?.content ?? '');
  const selectedLabel = rawContent.trim();
  const matchedIndex = routes.findIndex(
    r => r.label.toLowerCase() === selectedLabel.toLowerCase(),
  );

  const handleId = matchedIndex >= 0 ? `route-${matchedIndex}` : `route-0`;

  return {
    result:         selectedLabel,
    selectedHandle: handleId,
  };
};

/**
 * Condition node — evaluates rules against upstream data.
 * Returns 'condition-true' or 'condition-false' as the selected handle.
 */
const conditionHandler: NodeHandler = async({ config, upstreamOutputs }) => {
  const rules = (config.rules as Array<{ field: string; operator: string; value: string }>) || [];
  const combinator = (config.combinator as 'and' | 'or') || 'and';

  // Build a flat lookup of upstream data for rule evaluation
  const data: Record<string, unknown> = {};
  for (const output of upstreamOutputs) {
    if (typeof output.result === 'object' && output.result !== null) {
      Object.assign(data, output.result);
    }
    data[output.nodeId] = output.result;
    data[output.label] = output.result;
  }

  const evaluateRule = (rule: { field: string; operator: string; value: string }): boolean => {
    const fieldValue = String(data[rule.field] ?? '');
    const ruleValue = rule.value;

    switch (rule.operator) {
      case 'equals':         return fieldValue === ruleValue;
      case 'not_equals':     return fieldValue !== ruleValue;
      case 'contains':       return fieldValue.includes(ruleValue);
      case 'not_contains':   return !fieldValue.includes(ruleValue);
      case 'starts_with':    return fieldValue.startsWith(ruleValue);
      case 'ends_with':      return fieldValue.endsWith(ruleValue);
      case 'is_empty':       return fieldValue === '';
      case 'is_not_empty':   return fieldValue !== '';
      case 'greater_than':   return Number(fieldValue) > Number(ruleValue);
      case 'less_than':      return Number(fieldValue) < Number(ruleValue);
      default:               return false;
    }
  };

  const results = rules.map(evaluateRule);
  const passed = combinator === 'and'
    ? results.every(Boolean)
    : results.some(Boolean);

  return {
    result:         passed,
    selectedHandle: passed ? 'condition-true' : 'condition-false',
  };
};

/**
 * Wait node — delays execution for the configured duration.
 */
const waitHandler: NodeHandler = async({ config, abortSignal }) => {
  const amount = Number(config.delayAmount) || 0;
  const unit = (config.delayUnit as string) || 'seconds';

  const multipliers: Record<string, number> = {
    seconds: 1000,
    minutes: 60_000,
    hours:   3_600_000,
  };

  const ms = amount * (multipliers[unit] || 1000);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Wait aborted'));
    }, { once: true });
  });

  return { result: `Waited ${amount} ${unit}` };
};

/**
 * Loop node — the executor handles the actual looping logic.
 * This handler just evaluates whether the loop should continue.
 */
const loopHandler: NodeHandler = async({ config, context }) => {
  const maxIterations = Number(config.maxIterations) || 10;
  const conditionExpr = (config.condition as string) || '';

  // The executor tracks iteration count via context.variables
  const iterKey = `__loop_iteration`;
  const currentIteration = (context.variables[iterKey] as number) || 0;

  if (currentIteration >= maxIterations) {
    return { result: { continue: false, iteration: currentIteration, reason: 'max_iterations' } };
  }

  // Simple condition evaluation — if the condition is empty, always continue
  let shouldContinue = true;
  if (conditionExpr) {
    // Check if any upstream output contains the condition string (basic match)
    const allOutputs = Array.from(context.nodeOutputs.values())
      .map(o => String(o.result))
      .join(' ');
    shouldContinue = allOutputs.includes(conditionExpr);
  }

  return { result: { continue: shouldContinue, iteration: currentIteration } };
};

/**
 * Parallel node — structural. The executor forks on all outgoing edges.
 * This handler is a pass-through.
 */
const parallelHandler: NodeHandler = async({ upstreamOutputs }) => {
  return { result: upstreamOutputs.map(o => o.result) };
};

/**
 * Merge node — structural. The executor waits for incoming branches.
 * This handler combines the results.
 */
const mergeHandler: NodeHandler = async({ config, upstreamOutputs }) => {
  const strategy = (config.strategy as string) || 'wait-all';
  return {
    result: {
      strategy,
      merged: upstreamOutputs.map(o => ({
        nodeId: o.nodeId,
        label:  o.label,
        result: o.result,
      })),
    },
  };
};

/**
 * Sub-workflow node — loads and executes another workflow.
 */
const subWorkflowHandler: NodeHandler = async(args) => {
  const { config, context, abortSignal, emitEvent } = args;

  const workflowId = config.workflowId as string;
  const awaitResponse = config.awaitResponse !== false;

  if (!workflowId) {
    return { result: { error: 'No workflow ID configured' } };
  }

  // Load the sub-workflow definition from disk
  const fs = await import('fs');
  const path = await import('path');
  const { resolveSullaWorkflowsDir } = await import('@pkg/agent/utils/sullaPaths');
  const filePath = path.join(resolveSullaWorkflowsDir(), `${workflowId}.json`);

  if (!fs.existsSync(filePath)) {
    return { result: { error: `Sub-workflow not found: ${workflowId}` } };
  }

  const definition = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Lazy import to avoid circular dependency
  const { WorkflowExecutor } = await import('./WorkflowExecutor');

  const subPayload = args.upstreamOutputs.length > 0
    ? args.upstreamOutputs[args.upstreamOutputs.length - 1].result
    : context.triggerPayload;

  const subExecutor = new WorkflowExecutor(definition, subPayload, {
    parentExecutionId: context.executionId,
    abortSignal,
    emitEvent,
  });

  if (awaitResponse) {
    const runState = await subExecutor.execute();
    const outputs = Array.from(runState.context.nodeOutputs.values());
    const lastOutput = outputs[outputs.length - 1];
    return { result: lastOutput?.result ?? null };
  }

  // Fire-and-forget
  subExecutor.execute().catch(() => {});
  return { result: { started: workflowId } };
};

/**
 * User-input node — pauses execution and waits for user response.
 * The executor handles the pause/resume lifecycle.
 */
const userInputHandler: NodeHandler = async(args) => {
  const { nodeId, config, emitEvent } = args;

  const promptText = (config.promptText as string) || 'Please provide input:';

  // Emit a waiting event — the UI will show the prompt
  emitEvent({
    type:      'node_waiting',
    nodeId,
    nodeLabel: args.label,
    status:    'waiting',
    output:    { promptText },
  });

  // The executor will pause here and resume when user responds.
  // This is a placeholder — the actual pause/resume is handled by WorkflowExecutor.
  // We return a special marker so the executor knows to pause.
  return { result: { __waiting: true, promptText } };
};

/**
 * Response node — sends the accumulated output to the user.
 * If a responseTemplate is configured, resolves {{variable}} tokens against the context.
 */
const responseHandler: NodeHandler = async({ config, upstreamOutputs, context }) => {
  const template = (config.responseTemplate as string) || '';

  if (template.trim()) {
    return { result: resolveTemplate(template, context, upstreamOutputs) };
  }

  // Legacy: concatenate upstream outputs
  const output = upstreamOutputs.length > 0
    ? upstreamOutputs.map(o => typeof o.result === 'string' ? o.result : JSON.stringify(o.result)).join('\n\n')
    : String(context.triggerPayload || '');

  return { result: output };
};

/**
 * Transfer node — hands off to another workflow, ending this branch.
 */
const transferHandler: NodeHandler = async(args) => {
  const { config, context, abortSignal, emitEvent, upstreamOutputs } = args;
  const targetWorkflowId = config.targetWorkflowId as string;

  if (!targetWorkflowId) {
    return { result: { error: 'No target workflow configured' } };
  }

  const fs = await import('fs');
  const path = await import('path');
  const { resolveSullaWorkflowsDir } = await import('@pkg/agent/utils/sullaPaths');
  const filePath = path.join(resolveSullaWorkflowsDir(), `${targetWorkflowId}.json`);

  if (!fs.existsSync(filePath)) {
    return { result: { error: `Target workflow not found: ${targetWorkflowId}` } };
  }

  const definition = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const { WorkflowExecutor } = await import('./WorkflowExecutor');

  const payload = upstreamOutputs.length > 0
    ? upstreamOutputs[upstreamOutputs.length - 1].result
    : context.triggerPayload;

  const executor = new WorkflowExecutor(definition, payload, {
    parentExecutionId: context.executionId,
    abortSignal,
    emitEvent,
  });

  // Fire-and-forget — transfer means this branch ends
  executor.execute().catch(() => {});

  return { result: { transferred: targetWorkflowId } };
};

// ── Registry ──

const handlers: Record<string, NodeHandler> = {
  // Triggers
  'calendar':          triggerHandler,
  'chat-app':          triggerHandler,
  'heartbeat':         triggerHandler,
  'sulla-desktop':     triggerHandler,
  'chat-completions':  triggerHandler,

  // Agent
  'agent':             agentHandler,
  'tool-call':         toolCallHandler,

  // Routing
  'router':            routerHandler,
  'condition':         conditionHandler,

  // Flow control
  'wait':              waitHandler,
  'loop':              loopHandler,
  'parallel':          parallelHandler,
  'merge':             mergeHandler,
  'sub-workflow':      subWorkflowHandler,

  // I/O
  'user-input':        userInputHandler,
  'response':          responseHandler,
  'transfer':          transferHandler,
};

export function getNodeHandler(subtype: WorkflowNodeSubtype): NodeHandler | undefined {
  return handlers[subtype];
}

export function registerNodeHandler(subtype: string, handler: NodeHandler): void {
  handlers[subtype] = handler;
}
