// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import FileDetail from '@pkg/pages/files/FileDetail.vue';

import type { FilesDataSource, FilesDetail, FilesItem, FilesVersion } from '@pkg/pages/files/types';

describe('Use Case file publication conflict activity', () => {
  it('shows the owner decision and the conflicting published version after reopening the file', async() => {
    const at = '2026-11-20T12:00:00.000Z';
    const item: FilesItem = {
      id: 'agent-file', path: 'Use Cases/agents/tester/agent.yaml', mime: 'application/yaml', size: 104,
      updatedAt: at, currentVersionId: 'version-new', publishedVersionId: 'version-new', versionCount: 2,
      createdByType: 'user', createdById: 'owner-1', indexStatus: 'pending', indexReason: '',
    };
    const version: FilesVersion = { id: 'version-new', size: 104, deleted: false, created_by_type: 'user', created_by_id: 'owner-1', created_at: at, current: true, versionNumber: '2.0' };
    const message = 'The owner chose shared model routing, which was kept. Update the agent or the file to reconcile them.';
    const file: FilesDetail = {
      item, version, provenance: { type: 'user', id: 'owner-1' }, links: [], access: { inherited: [] },
      activity: [
        { id: 'conflict', who_type: 'user', who_id: 'owner-1', action: 'use-case-model-conflict', at, version_id: version.id, message },
        { id: 'unrelated', who_type: 'user', who_id: 'owner-1', action: 'upload', at, message: 'Generic audit content is private' },
      ],
    };
    const dataSource = { capabilities: {}, detail: async() => file, history: async() => [version] } as unknown as FilesDataSource;
    const wrapper = mount(FileDetail, { props: { item, dataSource, collection: { id: 'home', name: 'My Files', home: 'local', retentionPolicy: {} } } });
    try {
      await flushPromises();
      await wrapper.findAll('button').find(button => button.text() === 'Activity')!.trigger('click');
      const activity = wrapper.get('.pane.activity').text();
      expect(activity).toContain('reported a model settings conflict');
      expect(activity).toContain(`Version 2.0 · ${ message }`);
      expect(activity).not.toContain('Generic audit content is private');
    } finally {
      wrapper.unmount();
    }
  });
});
