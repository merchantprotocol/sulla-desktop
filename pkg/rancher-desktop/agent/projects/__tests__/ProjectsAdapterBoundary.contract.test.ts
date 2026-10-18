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

  it('does not trust renderer-supplied actor identities', () => {
    const source = fs.readFileSync(`${ repoRoot }/pkg/rancher-desktop/main/workItemsEvents.ts`, 'utf8');
    expect(source).not.toContain("changes.actor ?? 'human'");
    expect(source).not.toContain("input.actor ?? 'human'");
    expect(source).toContain("projects.updateTask(id, { ...changes, actor: 'human' }");
    expect(source).toContain("projects.createTask({ ...input, actor: 'human' }");
  });

  it('keeps active Desktop callers on the authenticated Projects client', () => {
    const application = fs.readFileSync(
      `${ repoRoot }/pkg/rancher-desktop/agent/projects/application/ProjectsApplicationService.ts`, 'utf8',
    );
    expect(application).toContain('getProjectsApiClient');
    expect(application).not.toMatch(/PostgresProjectsRepository|postgresClient/);

    const callers = [
      'agent/nodes/HeartbeatNode.ts',
      'agent/prompts/projectReport.ts',
      'agent/prompts/heartbeatIdeaLab.ts',
      'agent/services/HumanCommentTriage.ts',
      'main/mobileCompanion.ts',
      'main/cloud/desktopObjectSync.ts',
      'main/workItemsEvents.ts',
    ];
    for (const caller of callers) {
      const source = fs.readFileSync(`${ repoRoot }/pkg/rancher-desktop/${ caller }`, 'utf8');
      expect(source).not.toMatch(/\b(?:WorkItemsModel|WorkLaneDefinitionModel|WorkItemKnowledgeModel|WorkTaskDependencyModel)\.[a-zA-Z]+\s*\(/);
      expect(source).not.toMatch(/(?:FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+work_(?:projects|epics|tasks|task_comments|lane_definitions|item_knowledge_links)\b/i);
    }
  });

  it('keeps schema ownership in ordered migrations', () => {
    const source = fs.readFileSync(`${ repoRoot }/pkg/rancher-desktop/agent/database/models/WorkItemsModel.ts`, 'utf8');
    expect(source).not.toMatch(/CREATE\s+(?:TABLE|INDEX|EXTENSION)|ALTER\s+TABLE/i);
    expect(source).toContain('PostgresProjectsSchemaVerifier');
  });
});
