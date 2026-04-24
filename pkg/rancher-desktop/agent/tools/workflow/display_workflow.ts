/**
 * display_workflow — surface a saved routine as a workflow artifact in the
 * chat sidebar. Reads `~/sulla/routines/<slug>/routine.yaml` and publishes
 * the full routine document over the same WS pipeline assistant messages
 * use. The frontend's PersonaAdapter picks it up and opens (or updates
 * in place) a `workflow` artifact whose payload IS the routine — no
 * field mapping.
 *
 * Re-run after every edit so the sidebar card stays current while the
 * human watches the routine take shape next to the conversation.
 */

import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { BaseTool, ToolResponse } from '../base';

export class DisplayWorkflowWorker extends BaseTool {
  name = 'display_workflow';
  description = 'Surface a saved routine as a workflow artifact in the chat sidebar. Reads ~/sulla/routines/<slug>/routine.yaml and publishes the full document as a workflow_document WebSocket event — the artifact pane renders the node graph with routine-defined coordinates. Safe to call repeatedly after import_workflow: the sidebar artifact is deduped by workflow name so re-emits update the same card in place. Use this instead of opening the Routines editor tab when the user wants to watch the routine take shape inside the chat.';

  schemaDef = {
    slug: {
      type:        'string' as const,
      description: 'The routine slug — directory name under ~/sulla/routines/ containing a routine.yaml. Matches the slug used with marketplace/scaffold and workflow/import_workflow.',
    },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug: string = input.slug;

    const { resolveSullaRoutinesDir } = await import('@pkg/agent/utils/sullaPaths');
    const routinesDir = resolveSullaRoutinesDir();
    const yamlPath = path.join(routinesDir, slug, 'routine.yaml');

    if (!fs.existsSync(yamlPath)) {
      return {
        successBoolean: false,
        responseString: `routine.yaml not found at ${ yamlPath }. Scaffold the routine first with marketplace/scaffold.`,
      };
    }

    let definition: any;
    try {
      definition = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Failed to parse routine.yaml: ${ (err as Error).message }`,
      };
    }

    if (!definition || typeof definition !== 'object') {
      return {
        successBoolean: false,
        responseString: 'routine.yaml did not parse to an object.',
      };
    }

    if (!Array.isArray(definition.nodes)) {
      return {
        successBoolean: false,
        responseString: 'routine.yaml is missing a `nodes` array.',
      };
    }

    // Normalize the routine for the frontend: pass the exact shape the
    // WorkflowPayload renderer expects. No rename, no flatten — the
    // routine IS the payload.
    const workflow = {
      slug,
      id:          typeof definition.id === 'string' ? definition.id : slug,
      name:        typeof definition.name === 'string' ? definition.name : slug,
      description: typeof definition.description === 'string' ? definition.description : undefined,
      _status:     definition._status,
      viewport:    definition.viewport && typeof definition.viewport === 'object' ? definition.viewport : undefined,
      nodes:       definition.nodes,
      edges:       Array.isArray(definition.edges) ? definition.edges : [],
    };

    const published = await this.emitMessage('', 'workflow_document', { workflow });

    if (!published) {
      return {
        successBoolean: false,
        responseString: 'Failed to publish workflow_document — WebSocket channel not ready. Make sure the tool is invoked from an active chat turn.',
      };
    }

    const nodeCount = workflow.nodes.length;
    const edgeCount = workflow.edges.length;
    return {
      successBoolean: true,
      responseString: [
        `✓ Workflow "${ workflow.name }" published to the artifact sidebar.`,
        `  slug:  ${ slug }`,
        `  nodes: ${ nodeCount }`,
        `  edges: ${ edgeCount }`,
        ``,
        `The user can now see the routine in the right pane. Re-run this tool after each material edit to keep the sidebar in sync.`,
      ].join('\n'),
    };
  }
}
