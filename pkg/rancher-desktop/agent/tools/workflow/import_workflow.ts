import yaml from 'yaml';

import { BaseTool, ToolResponse } from '../base';

export class ImportWorkflowWorker extends BaseTool {
  name = 'import_workflow';
  description = 'Import an inline YAML workflow definition into Postgres so it can be executed.';

  schemaDef = {
    slug: {
      type:        'string' as const,
      description: 'The workflow slug / id.',
    },
    yaml: {
      type:        'string' as const,
      description: 'The complete workflow definition as YAML.',
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

    let definition: any;
    try {
      definition = yaml.parse(String(input.yaml ?? ''));
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Failed to parse workflow YAML: ${ (err as Error).message }`,
      };
    }

    if (!definition?.id || !definition?.name) {
      return {
        successBoolean: false,
        responseString: `Workflow YAML is missing required fields "id" and/or "name".`,
      };
    }

    const { postgresClient } = await import('@pkg/agent/database/PostgresClient');

    // Lock guard: never let an import overwrite a locked core routine. Core
    // routines are seeded from the bundled definition on boot — not importable.
    try {
      const locked = await postgresClient.queryOne(
        `SELECT system FROM workflows WHERE id = $1 LIMIT 1`,
        [definition.id],
      );
      if (locked?.system === true) {
        return {
          successBoolean: false,
          responseString: `"${ definition.id }" is a locked core routine baked into Sulla Desktop and cannot be imported over. You can disable it, but not replace it.`,
        };
      }
    } catch {
      // If the lookup fails, fall through — the DB upsert below surfaces real errors.
    }

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

    // The scheduler only scans the DB at boot and on UI save/promote events —
    // without this, CLI-imported routines stay unarmed until the next restart.
    try {
      const { getWorkflowSchedulerService } = await import('@pkg/agent/services/WorkflowSchedulerService');

      await getWorkflowSchedulerService().refresh();
    } catch (err) {
      console.warn('[import_workflow] Failed to refresh workflow schedules:', err);
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
