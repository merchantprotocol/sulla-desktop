import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { BaseTool, ToolResponse } from '../base';

export class ImportWorkflowWorker extends BaseTool {
  name = 'import_workflow';
  description = 'Import a local routine.yaml file into the workflows database so it can be executed. Reads from ~/sulla/routines/<slug>/routine.yaml and upserts into the DB.';

  schemaDef = {
    slug: {
      type:        'string' as const,
      description: 'The workflow slug — directory name under ~/sulla/routines/ containing a routine.yaml.',
    },
    status: {
      type:        'string' as const,
      optional:    true,
      description: 'Workflow status to set: draft | production | archive. Defaults to "production".',
    },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const slug: string = input.slug;
    const status: string = input.status || 'production';

    const { resolveSullaRoutinesDir } = await import('@pkg/agent/utils/sullaPaths');
    const routinesDir = resolveSullaRoutinesDir();
    const yamlPath = path.join(routinesDir, slug, 'routine.yaml');

    if (!fs.existsSync(yamlPath)) {
      return {
        successBoolean: false,
        responseString: `routine.yaml not found at ${ yamlPath }. Check the slug and make sure the file exists.`,
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

    if (!definition?.id || !definition?.name) {
      return {
        successBoolean: false,
        responseString: `routine.yaml is missing required fields "id" and/or "name".`,
      };
    }

    const { postgresClient } = await import('@pkg/agent/database/PostgresClient');

    try {
      await postgresClient.query(
        `INSERT INTO workflows (id, name, description, version, status, definition, enabled, source_template_slug, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name                 = EXCLUDED.name,
           description          = EXCLUDED.description,
           version              = EXCLUDED.version,
           status               = EXCLUDED.status,
           definition           = EXCLUDED.definition,
           enabled              = EXCLUDED.enabled,
           source_template_slug = EXCLUDED.source_template_slug,
           updated_at           = NOW()`,
        [
          definition.id,
          definition.name,
          definition.description ?? null,
          String(definition.version ?? '1'),
          status,
          JSON.stringify(definition),
          definition.enabled !== false,
          slug,
        ],
      );
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `DB upsert failed: ${ (err as Error).message }`,
      };
    }

    return {
      successBoolean: true,
      responseString: [
        `✓ Workflow "${ definition.name }" imported successfully.`,
        `  id:     ${ definition.id }`,
        `  slug:   ${ slug }`,
        `  status: ${ status }`,
        `  nodes:  ${ (definition.nodes ?? []).length }`,
        `  edges:  ${ (definition.edges ?? []).length }`,
        ``,
        `Run it with: sulla meta/execute_workflow '{"workflowId":"${ definition.id }"}'`,
      ].join('\n'),
    };
  }
}
