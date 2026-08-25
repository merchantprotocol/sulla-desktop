import { postgresClient } from '../../database/PostgresClient';

export const PROJECTS_CORE_RELATIONS = Object.freeze([
  'work_projects',
  'work_epics',
  'work_tasks',
  'work_task_comments',
]);

export class PostgresProjectsSchemaVerifier {
  static async verify(relations: readonly string[] = PROJECTS_CORE_RELATIONS): Promise<void> {
    const rows = await postgresClient.query<{ relation_name: string; relation: string | null }>(
      `SELECT relation_name, to_regclass('public.' || relation_name)::text AS relation
         FROM unnest($1::text[]) AS required(relation_name)`,
      [[...relations]],
    );
    const missing = rows.filter(row => row.relation === null).map(row => row.relation_name);
    if (missing.length > 0) {
      throw new Error(`Projects schema is not migrated; missing relations: ${ missing.join(', ') }`);
    }
  }
}
