// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. The sidebar decides which collection rows a person sees and can open. An organization
// collection listed as a personal tracked folder, or a personal folder hidden under Organizations, sends the
// person to the wrong collection; an empty Organizations block would show a heading with nothing under it.
import { ref } from 'vue';
import { describe, expect, it } from 'vitest';

import { FilesBrowserLocation } from './FilesBrowserLocation';

import type { FilesBrowserState } from './FilesBrowserState';
import type { FilesSnapshot } from '../types';

type Collection = NonNullable<FilesSnapshot['availableCollections']>[number];

const personal = (id:string, name:string, extra:Partial<Collection> = {}):Collection => ({ id, name, treePath: '', systemArea: null, workspaceScope: 'personal', ...extra });
const org = (id:string, name:string, orgName:string, extra:Partial<Collection> = {}):Collection => ({ id, name, treePath: `Organizations/${ orgName }/${ name }`, systemArea: null, workspaceScope: 'organization', orgId: `org-${ orgName }`, orgName, level: 'write', ...extra });

const locationWith = (availableCollections:Collection[] | undefined) => {
  const snapshot = ref(availableCollections === undefined ? null : { collection: { id: 'home', name: 'This desktop', home: '', retentionPolicy: {} }, availableCollections, files: [], status: {} } as unknown as FilesSnapshot);
  const state = { snapshot, collectionsRoot: ref(true), section: ref('files'), currentPath: ref(''), props: { dataSource: {} } } as unknown as FilesBrowserState;

  return new FilesBrowserLocation(state);
};

describe('FilesBrowserLocation organization collections', () => {
  it('groups organization collections by org name, then sorts each group by collection name', () => {
    const location = locationWith([
      personal('home', 'This desktop'),
      org('o3', 'Zeta notes', 'Beta Co'),
      org('o1', 'Board', 'Acme'),
      org('o2', 'Ads', 'Acme'),
      org('o4', 'Plans', 'Beta Co'),
    ]);

    expect(location.orgCollections.value.map(group => group.orgName)).toEqual(['Acme', 'Beta Co']);
    expect(location.orgCollections.value[0].collections.map(collection => collection.id)).toEqual(['o2', 'o1']);
    expect(location.orgCollections.value[1].collections.map(collection => collection.id)).toEqual(['o4', 'o3']);
  });

  it('keeps organization rows out of Tracked folders and keeps the personal tracked folders', () => {
    const location = locationWith([
      personal('home', 'This desktop'),
      personal('docs', 'Docs'),
      org('o1', 'Board', 'Acme'),
      personal('photos', 'Photos'),
    ]);

    expect(location.trackedCollections.value.map(collection => collection.id)).toEqual(['docs', 'photos']);
    expect(location.trackedCollections.value.some(collection => collection.workspaceScope === 'organization')).toBe(false);
  });

  it('reports no organization groups when the account has no organization collections, so the sidebar block stays hidden', () => {
    const location = locationWith([personal('home', 'This desktop'), personal('docs', 'Docs')]);

    expect(location.orgCollections.value).toEqual([]);
    expect(location.trackedCollections.value.map(collection => collection.id)).toEqual(['docs']);
  });

  it('reports no organization groups before a snapshot loads', () => {
    const location = locationWith(undefined);

    expect(location.orgCollections.value).toEqual([]);
    expect(location.trackedCollections.value).toEqual([]);
  });

  it('falls back to the org id as the heading when the org name is missing', () => {
    const location = locationWith([personal('home', 'This desktop'), org('o1', 'Board', '', { orgName: undefined, orgId: 'org-7' })]);

    expect(location.orgCollections.value.map(group => group.orgName)).toEqual(['org-7']);
  });
});
