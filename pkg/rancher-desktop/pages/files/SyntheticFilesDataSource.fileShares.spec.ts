import { SyntheticFilesDataSource } from './SyntheticFilesDataSource';

describe('Synthetic Files exact-file sharing contract', () => {
  test('lists, changes, and revokes one file grant without creating a folder grant', async() => {
    const source = new SyntheticFilesDataSource();
    const created = await source.shareFile('file-a', 'user', 'maya', 'view');

    expect((await source.listFileShares('file-a')).direct).toEqual([created]);
    expect((await source.listFileShares('file-b')).direct).toEqual([]);
    expect(await source.listFolderShares()).toEqual([]);

    const changed = await source.updateFileShare('file-a', created.id, 'edit');

    expect(changed.role).toBe('edit');
    await source.unshareFile('file-a', created.id);
    expect((await source.listFileShares('file-a')).direct).toEqual([]);
    expect(await source.listFolderShares()).toEqual([]);
  });
});
