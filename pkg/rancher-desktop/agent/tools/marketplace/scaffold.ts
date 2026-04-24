import * as fs from 'fs';
import * as path from 'path';

import { BaseTool, ToolResponse } from '../base';
import { artifactDir, isArtifactKind, KIND_LAYOUTS, ArtifactKind } from './types';

/**
 * Scaffold a new artifact directory with kind-appropriate skeleton files.
 * Does NOT touch the marketplace — pure local file generator.
 */
export class MarketplaceScaffoldWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : slug;
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim().toLowerCase() : 'python'; // function-only

    if (!isArtifactKind(kind)) {
      return { successBoolean: false, responseString: `Missing or invalid "kind". Must be one of: skill, function, workflow, agent, recipe.` };
    }
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return { successBoolean: false, responseString: `Invalid "slug". Use kebab-case: ^[a-z0-9][a-z0-9-]*$` };
    }

    const dir = artifactDir(kind, slug);
    if (fs.existsSync(dir)) {
      return { successBoolean: false, responseString: `Directory already exists: ${ dir }. Pick a different slug or remove it first.` };
    }

    fs.mkdirSync(dir, { recursive: true });

    const files = generateSkeleton(kind, { slug, name, description, runtime });
    const written: string[] = [];
    for (const [relPath, contents] of Object.entries(files)) {
      const p = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, contents, 'utf-8');
      written.push(relPath);
    }

    return {
      successBoolean: true,
      responseString: `Scaffolded ${ kind }/${ slug } at ${ dir }\nFiles created (${ written.length }):\n${ written.map(f => `  - ${ f }`).join('\n') }\n\nNext: edit the manifest, then \`sulla marketplace/validate '{"kind":"${ kind }","slug":"${ slug }"}'\``,
    };
  }
}

function generateSkeleton(
  kind: ArtifactKind,
  ctx: { slug: string; name: string; description: string; runtime: string },
): Record<string, string> {
  const now = new Date().toISOString();

  switch (kind) {
  case 'skill':
    return {
      [KIND_LAYOUTS.skill.manifest]: `# ${ ctx.name }\n\n${ ctx.description || 'One-line description of what this skill does.' }\n\n## When to use this skill\n\n- Trigger condition 1\n- Trigger condition 2\n\n## Instructions\n\nStep-by-step instructions the agent follows when this skill activates.\n`,
    };

  case 'function': {
    const ext = ctx.runtime === 'node' ? 'js' : ctx.runtime === 'shell' ? 'sh' : 'py';
    const handlerLine = ctx.runtime === 'shell' ? 'main.sh' : `main.${ ext }::handler`;
    const yaml = `apiVersion: sulla/v1
kind: Function
id: function-${ ctx.slug }
slug: ${ ctx.slug }
name: ${ ctx.name }
description: ${ ctx.description || 'TODO: describe what this function does.' }
schemaversion: 1
spec:
  runtime: ${ ctx.runtime }
  entrypoint: ${ handlerLine }
  inputs:
    example:
      type: string
      description: "TODO: replace with real inputs"
      default: "hello"
      required: false
  outputs:
    result:
      type: string
      description: "TODO: replace with real outputs"
  timeout: 60s
  permissions:
    network: []
`;
    const handler = generateHandler(ctx.runtime);
    const out: Record<string, string> = {
      'function.yaml': yaml,
      [`main.${ ext }`]: handler,
    };
    if (ctx.runtime === 'python') out['requirements.txt'] = '';
    if (ctx.runtime === 'node') out['package.json'] = JSON.stringify({ name: ctx.slug, version: '1.0.0', type: 'module' }, null, 2) + '\n';
    if (ctx.runtime === 'shell') out['packages.txt'] = '';
    return out;
  }

  case 'workflow':
    return {
      [KIND_LAYOUTS.workflow.manifest]: `id: ${ ctx.slug }
name: ${ ctx.name }
description: ${ ctx.description || 'TODO: describe what this workflow does.' }
version: "1"
enabled: true
createdAt: "${ now }"
updatedAt: "${ now }"
nodes:
  - id: trigger-1
    type: workflow
    position: { x: 100, y: 100 }
    data:
      subtype: manual
      category: trigger
      label: Manual trigger
      config: {}
  - id: agent-1
    type: workflow
    position: { x: 400, y: 100 }
    data:
      subtype: agent
      category: agent
      label: Do the thing
      config:
        agentId: sulla-desktop
        agentName: Sulla
        additionalPrompt: "TODO: describe what this agent should do."
        orchestratorInstructions: ""
        successCriteria: ""
        completionContract: "default"
edges:
  - id: e1
    source: trigger-1
    target: agent-1
    sourceHandle: out
    targetHandle: in
    label: ""
    animated: false
viewport: { x: 0, y: 0, zoom: 1 }
`,
    };

  case 'agent':
    return {
      [KIND_LAYOUTS.agent.manifest]: `id: ${ ctx.slug }
name: ${ ctx.name }
description: ${ ctx.description || 'TODO: describe what this agent does.' }
model: claude-sonnet-4-6
tools:
  - meta
  - browser
  - github
`,
      'soul.md': `# ${ ctx.name } — Soul\n\n${ ctx.description || "TODO: describe this agent's role, voice, and operating principles." }\n\n## Identity\n\n## Operating principles\n\n## Tools to prefer\n`,
    };

  case 'recipe':
    return {
      [KIND_LAYOUTS.recipe.manifest]: `slug: ${ ctx.slug }
name: ${ ctx.name }
description: ${ ctx.description || 'TODO: describe what this recipe does.' }
version: "1.0.0"
publisher: ""
categories: []
icon: icon.png
extra_urls: []
`,
      'docker-compose.yml': `version: "3.9"\nservices:\n  ${ ctx.slug }:\n    image: ghcr.io/your-org/${ ctx.slug }:latest\n    ports:\n      - "PORT:PORT"\n    restart: unless-stopped\n`,
      'installation.yaml': `pre_install: []\npost_install: []\n`,
    };
  }
}

function generateHandler(runtime: string): string {
  if (runtime === 'node') {
    return `export async function handler(inputs) {\n  return { result: \`hello, \${ inputs.example ?? 'world' }\` };\n}\n`;
  }
  if (runtime === 'shell') {
    return `#!/usr/bin/env bash\nset -euo pipefail\ninputs=$(cat)\nname=$(echo "$inputs" | jq -r '.example // "world"')\ncat <<JSON\n{ "result": "hello, $name" }\nJSON\n`;
  }
  return `def handler(inputs: dict) -> dict:\n    name = inputs.get("example", "world")\n    return {"result": f"hello, {name}"}\n`;
}
