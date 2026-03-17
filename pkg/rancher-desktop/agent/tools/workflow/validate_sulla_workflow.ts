import { BaseTool, ToolResponse } from '../base';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

// ── Valid subtypes and their required categories ──

const SUBTYPE_CATEGORY_MAP: Record<string, string> = {
  'calendar':          'trigger',
  'chat-app':          'trigger',
  'heartbeat':         'trigger',
  'sulla-desktop':     'trigger',
  'workbench':         'trigger',
  'chat-completions':  'trigger',
  'agent':             'agent',
  'tool-call':         'agent',
  'router':            'routing',
  'condition':         'routing',
  'wait':              'flow-control',
  'loop':              'flow-control',
  'parallel':          'flow-control',
  'merge':             'flow-control',
  'sub-workflow':      'flow-control',
  'user-input':        'io',
  'response':          'io',
  'transfer':          'io',
};

// ── Required config fields per subtype ──

const REQUIRED_CONFIG_FIELDS: Record<string, string[]> = {
  'calendar':          ['triggerType', 'triggerDescription'],
  'chat-app':          ['triggerType', 'triggerDescription'],
  'heartbeat':         ['triggerType', 'triggerDescription'],
  'sulla-desktop':     ['triggerType', 'triggerDescription'],
  'workbench':         ['triggerType', 'triggerDescription'],
  'chat-completions':  ['triggerType', 'triggerDescription'],
  'agent':             ['agentId', 'agentName', 'additionalPrompt', 'userMessage', 'beforePrompt', 'successCriteria', 'completionContract'],
  'tool-call':         ['integrationSlug', 'endpointName', 'accountId', 'defaults', 'preCallDescription'],
  'router':            ['classificationPrompt', 'routes'],
  'condition':         ['rules', 'combinator'],
  'wait':              ['delayAmount', 'delayUnit'],
  'loop':              ['maxIterations', 'condition', 'conditionMode'],
  'parallel':          [],
  'merge':             ['strategy'],
  'sub-workflow':      ['workflowId', 'awaitResponse'],
  'user-input':        ['promptText'],
  'response':          ['responseTemplate'],
  'transfer':          ['targetWorkflowId'],
};

const VALID_TOP_LEVEL_KEYS = new Set([
  'id', 'name', 'description', 'version', 'enabled',
  'createdAt', 'updatedAt', 'nodes', 'edges', 'viewport',
]);

const VALID_NODE_KEYS = new Set(['id', 'type', 'position', 'data']);

const VALID_EDGE_KEYS = new Set([
  'id', 'source', 'target', 'sourceHandle', 'targetHandle', 'label', 'animated',
]);

interface ValidationIssue {
  severity: 'error' | 'warning';
  path:     string;
  message:  string;
}

function validateWorkflowDefinition(def: any, filePath?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!def || typeof def !== 'object') {
    issues.push({ severity: 'error', path: '/', message: 'Workflow definition is not an object' });
    return issues;
  }

  // ── Top-level keys ──
  for (const key of Object.keys(def)) {
    if (!VALID_TOP_LEVEL_KEYS.has(key)) {
      issues.push({ severity: 'error', path: `/${key}`, message: `Invalid top-level key "${key}". Only allowed: ${[...VALID_TOP_LEVEL_KEYS].join(', ')}` });
    }
  }

  if (!def.id || typeof def.id !== 'string') {
    issues.push({ severity: 'error', path: '/id', message: 'Missing or non-string "id" field' });
  }
  if (!def.name || typeof def.name !== 'string') {
    issues.push({ severity: 'error', path: '/name', message: 'Missing or non-string "name" field' });
  }
  if (!Array.isArray(def.nodes)) {
    issues.push({ severity: 'error', path: '/nodes', message: '"nodes" must be an array' });
    return issues;
  }
  if (!Array.isArray(def.edges)) {
    issues.push({ severity: 'error', path: '/edges', message: '"edges" must be an array' });
  }

  // ── Node validation ──
  const nodeIds = new Set<string>();
  let triggerCount = 0;

  for (let i = 0; i < def.nodes.length; i++) {
    const node = def.nodes[i];
    const np = `/nodes[${i}]`;

    if (!node || typeof node !== 'object') {
      issues.push({ severity: 'error', path: np, message: 'Node is not an object' });
      continue;
    }

    // Extra keys
    for (const key of Object.keys(node)) {
      if (!VALID_NODE_KEYS.has(key)) {
        issues.push({ severity: 'error', path: `${np}/${key}`, message: `Invalid node key "${key}". Only allowed: ${[...VALID_NODE_KEYS].join(', ')}` });
      }
    }

    // id
    if (!node.id || typeof node.id !== 'string') {
      issues.push({ severity: 'error', path: `${np}/id`, message: 'Missing or non-string node "id"' });
    } else {
      if (nodeIds.has(node.id)) {
        issues.push({ severity: 'error', path: `${np}/id`, message: `Duplicate node id "${node.id}"` });
      }
      nodeIds.add(node.id);
      if (!/^node-\d+$/.test(node.id)) {
        issues.push({ severity: 'warning', path: `${np}/id`, message: `Node id "${node.id}" does not follow "node-{timestamp}" pattern` });
      }
    }

    // type
    if (node.type !== 'workflow') {
      issues.push({ severity: 'error', path: `${np}/type`, message: `Node type must be "workflow", got "${node.type}"` });
    }

    // position
    if (!node.position || typeof node.position !== 'object' || typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
      issues.push({ severity: 'error', path: `${np}/position`, message: 'Node must have "position" with numeric "x" and "y"' });
    }

    // data
    if (!node.data || typeof node.data !== 'object') {
      issues.push({ severity: 'error', path: `${np}/data`, message: 'Node must have a "data" object' });
      continue;
    }

    const { subtype, category, label, config } = node.data;

    // subtype
    if (!subtype || !SUBTYPE_CATEGORY_MAP[subtype]) {
      issues.push({ severity: 'error', path: `${np}/data/subtype`, message: `Invalid subtype "${subtype}". Valid: ${Object.keys(SUBTYPE_CATEGORY_MAP).join(', ')}` });
      continue;
    }

    // category match
    const expectedCategory = SUBTYPE_CATEGORY_MAP[subtype];
    if (category !== expectedCategory) {
      issues.push({ severity: 'error', path: `${np}/data/category`, message: `Subtype "${subtype}" requires category "${expectedCategory}", got "${category}"` });
    }

    if (expectedCategory === 'trigger') {
      triggerCount++;
    }

    // label
    if (!label || typeof label !== 'string') {
      issues.push({ severity: 'warning', path: `${np}/data/label`, message: 'Missing or empty node label' });
    }

    // config
    if (!config || typeof config !== 'object') {
      issues.push({ severity: 'error', path: `${np}/data/config`, message: 'Node must have a "config" object' });
      continue;
    }

    // Config field validation
    const requiredFields = REQUIRED_CONFIG_FIELDS[subtype] || [];
    const configKeys = Object.keys(config);

    for (const field of requiredFields) {
      if (!(field in config)) {
        issues.push({ severity: 'error', path: `${np}/data/config/${field}`, message: `Missing required config field "${field}" for subtype "${subtype}"` });
      }
    }

    // Extra config fields
    for (const key of configKeys) {
      if (!requiredFields.includes(key)) {
        issues.push({ severity: 'error', path: `${np}/data/config/${key}`, message: `Unknown config field "${key}" for subtype "${subtype}". Allowed: ${requiredFields.join(', ') || '(none)'}` });
      }
    }

    // Agent-specific: check for common wrong field names
    if (subtype === 'agent') {
      const forbiddenAgentFields = ['systemPrompt', 'prompt', 'instructions', 'input', 'agentDescription', 'description', 'tools', 'async', 'output_var', 'depends_on', 'message'];
      for (const bad of forbiddenAgentFields) {
        if (bad in config) {
          issues.push({ severity: 'error', path: `${np}/data/config/${bad}`, message: `Forbidden agent config field "${bad}". Agent nodes only accept: ${requiredFields.join(', ')}` });
        }
      }
    }
  }

  if (triggerCount === 0) {
    issues.push({ severity: 'error', path: '/nodes', message: 'Workflow must have at least one trigger node' });
  }

  // ── Edge validation ──
  const edges = Array.isArray(def.edges) ? def.edges : [];

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const ep = `/edges[${i}]`;

    if (!edge || typeof edge !== 'object') {
      issues.push({ severity: 'error', path: ep, message: 'Edge is not an object' });
      continue;
    }

    // Forbidden patterns
    if ('from' in edge || 'to' in edge) {
      issues.push({ severity: 'error', path: ep, message: 'Edges must use "source"/"target", NOT "from"/"to"' });
    }

    // Extra keys
    for (const key of Object.keys(edge)) {
      if (!VALID_EDGE_KEYS.has(key)) {
        issues.push({ severity: 'warning', path: `${ep}/${key}`, message: `Unexpected edge key "${key}"` });
      }
    }

    if (!edge.id || typeof edge.id !== 'string') {
      issues.push({ severity: 'error', path: `${ep}/id`, message: 'Missing or non-string edge "id"' });
    }
    if (!edge.source || typeof edge.source !== 'string') {
      issues.push({ severity: 'error', path: `${ep}/source`, message: 'Missing or non-string edge "source"' });
    } else if (!nodeIds.has(edge.source)) {
      issues.push({ severity: 'error', path: `${ep}/source`, message: `Edge source "${edge.source}" does not match any node id` });
    }
    if (!edge.target || typeof edge.target !== 'string') {
      issues.push({ severity: 'error', path: `${ep}/target`, message: 'Missing or non-string edge "target"' });
    } else if (!nodeIds.has(edge.target)) {
      issues.push({ severity: 'error', path: `${ep}/target`, message: `Edge target "${edge.target}" does not match any node id` });
    }
  }

  // ── Reachability check: every non-trigger node should be reachable ──
  const targetSet = new Set(edges.map((e: any) => e?.target).filter(Boolean));
  for (const node of def.nodes) {
    if (!node?.data || !node.id) continue;
    const cat = SUBTYPE_CATEGORY_MAP[node.data.subtype];
    if (cat === 'trigger') continue;
    if (!targetSet.has(node.id)) {
      issues.push({ severity: 'warning', path: `/nodes[id=${node.id}]`, message: `Node "${node.data.label || node.id}" is not the target of any edge (unreachable)` });
    }
  }

  return issues;
}

export class ValidateSullaWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const filePath = String(input.filePath || '').trim();
      const inlineYaml = String(input.yaml || '').trim();

      if (!filePath && !inlineYaml) {
        throw new Error('Provide either "filePath" (path to a workflow YAML file) or "yaml" (inline YAML string) to validate.');
      }

      let rawContent: string;
      let resolvedPath: string | undefined;

      if (filePath) {
        resolvedPath = filePath.startsWith('~')
          ? path.join(process.env.HOME || '', filePath.slice(1))
          : filePath;

        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`File not found: ${resolvedPath}`);
        }
        rawContent = fs.readFileSync(resolvedPath, 'utf-8');
      } else {
        rawContent = inlineYaml;
      }

      let parsed: any;
      try {
        parsed = yaml.parse(rawContent);
      } catch (parseErr) {
        return {
          successBoolean: false,
          responseString: JSON.stringify({
            valid:  false,
            source: resolvedPath || 'inline',
            error:  `YAML parse error: ${(parseErr as Error).message}`,
            issues: [{ severity: 'error', path: '/', message: `YAML parse error: ${(parseErr as Error).message}` }],
          }, null, 2),
        };
      }

      const issues = validateWorkflowDefinition(parsed, resolvedPath);
      const errors = issues.filter(i => i.severity === 'error');
      const warnings = issues.filter(i => i.severity === 'warning');

      const report = {
        valid:        errors.length === 0,
        source:       resolvedPath || 'inline',
        errorCount:   errors.length,
        warningCount: warnings.length,
        nodeCount:    Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0,
        edgeCount:    Array.isArray(parsed?.edges) ? parsed.edges.length : 0,
        issues,
      };

      return {
        successBoolean: errors.length === 0,
        responseString: JSON.stringify(report, null, 2),
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error validating Sulla workflow: ${(error as Error).message}`,
      };
    }
  }
}
