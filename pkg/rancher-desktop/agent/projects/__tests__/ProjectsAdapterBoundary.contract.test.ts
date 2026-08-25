import fs from 'node:fs';

import { describe, expect, it } from '@jest/globals';

const repoRoot = process.cwd();

describe('Projects adapter boundary contract', () => {
  it('does not let project CLI tools mutate WorkItemsModel directly', () => {
    const toolsDir = `${ repoRoot }/pkg/rancher-desktop/agent/tools/project`;
    const offenders = fs.readdirSync(toolsDir)
      .filter(name => name.endsWith('.ts'))
      .filter(name => /WorkItemsModel\.(?:upsert|insert|update|archive|addComment|setTask|removeTask)/
        .test(fs.readFileSync(`${ toolsDir }/${ name }`, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('routes every Projects tool model call through the application boundary', () => {
    const toolsDir = `${ repoRoot }/pkg/rancher-desktop/agent/tools/project`;
    const directModelCall = /\b(?:WorkItemsModel|WorkLaneDefinitionModel|WorkLaneWorkflowBindingModel|WorkProjectViewModel|WorkTaskWaitModel|WorkTaskDependencyModel|WorkItemKnowledgeModel|WorkConveyorMetricsModel)\.[a-zA-Z]+\s*\(/;
    const offenders = fs.readdirSync(toolsDir)
      .filter(name => name.endsWith('.ts'))
      .filter(name => directModelCall.test(fs.readFileSync(`${ toolsDir }/${ name }`, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('routes Electron work-item mutations through ProjectsApplicationService', () => {
    const source = fs.readFileSync(`${ repoRoot }/pkg/rancher-desktop/main/workItemsEvents.ts`, 'utf8');
    expect(source).toContain('importProjectsApplicationService');
    expect(source).not.toMatch(/WorkItemsModel\.(?:upsert|insert|update|archive|addComment|setTask|removeTask)/);
  });

  it('keeps schema ownership in ordered migrations', () => {
    const source = fs.readFileSync(`${ repoRoot }/pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts`, 'utf8');
    expect(source).not.toMatch(/CREATE\s+(?:TABLE|INDEX|EXTENSION)|ALTER\s+TABLE/i);
    expect(source).toContain('PostgresProjectsSchemaVerifier');
  });
});
