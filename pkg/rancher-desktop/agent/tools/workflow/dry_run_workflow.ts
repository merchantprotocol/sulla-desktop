import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import { resolveSullaRoutinesDir, resolveSullaWorkflowsDir } from '@pkg/agent/utils/sullaPaths';

import { BaseTool, ToolResponse } from '../base';

/**
 * Dry-run a workflow: walk the DAG from its trigger(s), follow all edges,
 * and report what would execute — without actually invoking any node. Used
 * to answer "is the path through this workflow what I expect?" before
 * committing to a real run.
 *
 * What dry_run does:
 * - Parses the YAML
 * - Builds the node/edge index
 * - Traverses from trigger nodes breadth-first
 * - Reports the execution order, any orphaned nodes, and any routing
 *   decisions it can't resolve statically (router / condition nodes)
 *
 * What dry_run does NOT do:
 * - Invoke agent nodes, run functions, call integrations, or hit any
 *   external side effect. Everything is structural.
 * - Resolve router/condition branches — those need runtime data, so the
 *   output marks them as "ambiguous" and lists both outgoing branches.
 */
export class DryRunWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';

    let yamlText: string | null = null;
    let sourcePath = '';

    if (filePath) {
      if (!fs.existsSync(filePath)) {
        return { successBoolean: false, responseString: `File not found: ${ filePath }` };
      }
      sourcePath = filePath;
      yamlText = fs.readFileSync(filePath, 'utf-8');
    } else if (slug) {
      // Check routines first, then workflows/
      const routinesPath = path.join(resolveSullaRoutinesDir(), slug, 'routine.yaml');
      const flatPath     = path.join(resolveSullaWorkflowsDir(), `${ slug }.yaml`);
      if (fs.existsSync(routinesPath)) {
        sourcePath = routinesPath;
        yamlText = fs.readFileSync(routinesPath, 'utf-8');
      } else if (fs.existsSync(flatPath)) {
        sourcePath = flatPath;
        yamlText = fs.readFileSync(flatPath, 'utf-8');
      } else {
        return { successBoolean: false, responseString: `No routine.yaml or flat workflow found for slug "${ slug }".` };
      }
    } else {
      return { successBoolean: false, responseString: 'Pass either "slug" (routine / workflow slug) or "filePath" (absolute path to a YAML).' };
    }

    let def: any;
    try {
      def = yaml.parse(yamlText!);
    } catch (err) {
      return { successBoolean: false, responseString: `YAML parse error: ${ (err as Error).message }` };
    }

    const nodes = Array.isArray(def?.nodes) ? def.nodes : [];
    const edges = Array.isArray(def?.edges) ? def.edges : [];

    if (nodes.length === 0) {
      return { successBoolean: false, responseString: 'Workflow has no nodes.' };
    }

    const byId = new Map<string, any>();
    for (const n of nodes) if (n?.id) byId.set(n.id, n);

    const outgoingByNode = new Map<string, { target: string; sourceHandle?: string; label?: string }[]>();
    for (const e of edges) {
      if (!e?.source || !e?.target) continue;
      if (!outgoingByNode.has(e.source)) outgoingByNode.set(e.source, []);
      outgoingByNode.get(e.source)!.push({ target: e.target, sourceHandle: e.sourceHandle, label: e.label });
    }

    const triggers = nodes.filter((n: any) => n?.data?.category === 'trigger');
    if (triggers.length === 0) {
      return { successBoolean: false, responseString: 'Workflow has no trigger nodes — cannot dry-run.' };
    }

    const visited = new Set<string>();
    const trace: string[] = [];
    const ambiguities: string[] = [];

    for (const trigger of triggers) {
      trace.push(`► trigger: ${ describeNode(trigger) }`);
      walk(trigger.id, 1);
    }

    function walk(nodeId: string, depth: number): void {
      if (visited.has(nodeId)) {
        trace.push(`${ indent(depth) }↩ revisit ${ nodeId } (cycle or convergence — stopping)`);
        return;
      }
      visited.add(nodeId);
      const node = byId.get(nodeId);
      if (!node) {
        trace.push(`${ indent(depth) }⚠ missing node id ${ nodeId }`);
        return;
      }
      const outs = outgoingByNode.get(nodeId) ?? [];
      const subtype = node?.data?.subtype;

      if (subtype === 'router' || subtype === 'condition') {
        ambiguities.push(`${ nodeId } (${ subtype }) — ${ outs.length } branches: ${ outs.map(o => o.sourceHandle || o.label || o.target).join(', ') }`);
      }

      for (const o of outs) {
        trace.push(`${ indent(depth) }→ ${ describeEdge(o, node) } → ${ describeNode(byId.get(o.target)) }`);
        walk(o.target, depth + 1);
      }
    }

    const unreached = nodes.filter((n: any) => !visited.has(n?.id)).map((n: any) => n.id);

    const lines: string[] = [
      `Dry-run: ${ def.name || def.id || sourcePath }`,
      `Source:  ${ sourcePath }`,
      `Nodes:   ${ nodes.length } total, ${ visited.size } reachable from triggers, ${ unreached.length } orphaned`,
      '',
      '── Execution order (static walk) ──',
      ...trace,
    ];
    if (ambiguities.length > 0) {
      lines.push('', '── Runtime branches (can\'t resolve statically) ──', ...ambiguities.map(a => `  ${ a }`));
    }
    if (unreached.length > 0) {
      lines.push('', '── Orphan nodes (not reachable from any trigger) ──', ...unreached.map((id: string) => `  ${ id } — ${ describeNode(byId.get(id)) }`));
    }

    return {
      successBoolean: true,
      responseString: lines.join('\n'),
    };
  }
}

function describeNode(node: any): string {
  if (!node) return '(missing)';
  const label = node?.data?.label || node.id;
  const subtype = node?.data?.subtype ? `[${ node.data.subtype }]` : '';
  return `${ subtype } ${ label } (${ node.id })`;
}

function describeEdge(e: { sourceHandle?: string; label?: string }, _source: any): string {
  const handle = e.sourceHandle ? `:${ e.sourceHandle }` : '';
  const lbl = e.label ? ` "${ e.label }"` : '';
  return `edge${ handle }${ lbl }`;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}
