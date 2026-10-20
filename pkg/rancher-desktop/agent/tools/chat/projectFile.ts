import path from 'node:path';

const PROJECT_KINDS = new Set(['plan', 'spec', 'notes', 'report']);

function scalar(value: unknown): string {
  return JSON.stringify(String(value ?? ''));
}

function slug(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
}

function fileName(value: string): string {
  const clean = path.posix.basename(value).normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-').trim() || 'plan';
  return clean.toLowerCase().endsWith('.md') ? clean : `${ clean }.md`;
}

export function projectFileInput(input: any): { content: string; path: string } | undefined {
  const projectId = String(input.project_id ?? '').trim();
  if (!projectId) return undefined;
  const projectName = String(input.project_name ?? '').trim();
  if (!projectName) throw new Error('project_name is required with project_id.');
  const kind = String(input.document_kind ?? 'plan');
  if (!PROJECT_KINDS.has(kind)) throw new Error(`Unsupported project document kind "${ kind }".`);
  const now = new Date().toISOString();
  const relatedTasks = Array.isArray(input.related_tasks) ? input.related_tasks : [];
  const relatedPrs = Array.isArray(input.related_prs) ? input.related_prs : [];
  const metadata = [
    '---',
    `title: ${ scalar(input.name) }`,
    'project:',
    `  id: ${ scalar(projectId) }`,
    `  name: ${ scalar(projectName) }`,
    `epic: ${ scalar(input.epic ?? '') }`,
    `kind: ${ scalar(kind) }`,
    `owner_agent: ${ scalar(input.owner_agent ?? 'sulla') }`,
    `created: ${ scalar(now) }`,
    `updated: ${ scalar(now) }`,
    `status: ${ scalar(input.document_status ?? 'working') }`,
    `delete_when: ${ scalar(input.delete_when ?? 'When the project is closed and this document is no longer needed') }`,
    `related_prs: [${ relatedPrs.map(scalar).join(', ') }]`,
    `related_tasks: [${ relatedTasks.map(scalar).join(', ') }]`,
    '---',
    '',
  ].join('\n');
  return {
    content: `${ metadata }${ String(input.content ?? '') }`,
    path: `projects/${ slug(projectName) }/${ fileName(input.file_name ?? input.name) }`,
  };
}
