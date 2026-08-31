import fs from 'fs';

import { describe, expect, it } from '@jest/globals';
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';

const files = [
  'pkg/rancher-desktop/components/projects/ProjectDependencyGraph.vue',
  'pkg/rancher-desktop/components/projects/PipelineTemplateSettings.vue',
];

describe('Projects Phase 5 renderer contract', () => {
  it.each(files)('compiles %s without template or style diagnostics', (filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const { descriptor, errors } = parse(source, { filename });
    expect(errors).toEqual([]);
    expect(() => compileScript(descriptor, { id: filename })).not.toThrow();
    expect(compileTemplate({ id: filename, filename, source: descriptor.template?.content ?? '' }).errors).toEqual([]);
    expect(compileStyle({
      id:     filename,
      filename,
      source: descriptor.styles[0]?.content ?? '',
      scoped: true,
    }).errors).toEqual([]);
  });

  it('visualizes the server-owned ready frontier and exact dependency edges', () => {
    const source = fs.readFileSync(files[0], 'utf8');
    expect(source).toContain('listReadyTasks(props.project.id)');
    expect(source).toContain('listTaskDependencies(props.project.id)');
    expect(source).toContain('edge.task_id === taskId');
    expect(source).toContain('Blocked ·');
  });

  it('supports create, update, archive, apply, and ordered template stages', () => {
    const source = fs.readFileSync(files[1], 'utf8');
    for (const operation of [
      'createPipelineTemplate', 'updatePipelineTemplate', 'archivePipelineTemplate', 'applyPipelineTemplate',
    ]) expect(source).toContain(operation);
    expect(source).toContain('moveStage(index, -1)');
    expect(source).toContain('workflow-db-list');
  });

  it('routes readiness and template mutations through typed IPC application adapters', () => {
    const events = fs.readFileSync('pkg/rancher-desktop/main/workItemsEvents.ts', 'utf8');
    const ipcTypes = fs.readFileSync('pkg/rancher-desktop/typings/electron-ipc.d.ts', 'utf8');
    for (const channel of [
      'work-items:ready-tasks',
      'work-items:pipeline-templates-list',
      'work-items:pipeline-template-create',
      'work-items:pipeline-template-update',
      'work-items:pipeline-template-archive',
      'work-items:pipeline-template-apply',
    ]) {
      expect(events).toContain(`ipcMainProxy.handle('${ channel }'`);
      expect(ipcTypes).toContain(`'${ channel }'`);
    }
    expect(events).toContain("{ actor: 'human', source: 'ipc' }");
  });
});
