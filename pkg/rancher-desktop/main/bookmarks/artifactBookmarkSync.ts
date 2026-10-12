import type { ChatArtifactRecord } from '@pkg/shared/chatArtifacts';
import { bookmarkService } from '@pkg/main/bookmarks/bookmarkService';

export const ARTIFACTS_FOLDER_ID = 'sulla-artifacts';
export const ARTIFACTS_FOLDER_TITLE = 'Artifacts';

export function artifactBookmarkUrl(artifactId: string): string {
  return `sulla-artifact://${ encodeURIComponent(artifactId) }`;
}

type BookmarkStore = Pick<typeof bookmarkService, 'ensureFolder' | 'findByUrl' | 'create' | 'update' | 'remove'>;

export class ArtifactBookmarkSync {
  constructor(private readonly bookmarks: BookmarkStore = bookmarkService) {}

  async created(artifact: ChatArtifactRecord): Promise<void> {
    await this.bookmarks.ensureFolder(ARTIFACTS_FOLDER_ID, ARTIFACTS_FOLDER_TITLE);
    const url = artifactBookmarkUrl(artifact.id);
    if ((await this.bookmarks.findByUrl(url)).length > 0) return;
    await this.bookmarks.create({
      kind:     'bookmark',
      title:    artifact.name,
      url,
      parentId: ARTIFACTS_FOLDER_ID,
      index:    0,
    });
  }

  async renamed(artifact: ChatArtifactRecord): Promise<void> {
    const matches = await this.bookmarks.findByUrl(artifactBookmarkUrl(artifact.id));
    await Promise.all(matches.map(bookmark => this.bookmarks.update(bookmark.id, { title: artifact.name })));
  }

  async deleted(artifact: ChatArtifactRecord): Promise<void> {
    const matches = await this.bookmarks.findByUrl(artifactBookmarkUrl(artifact.id));
    await Promise.all(matches.map(bookmark => this.bookmarks.remove(bookmark.id, { recursive: true })));
  }

}

let instance: ArtifactBookmarkSync | null = null;

export function getArtifactBookmarkSync(): ArtifactBookmarkSync {
  instance ??= new ArtifactBookmarkSync();
  return instance;
}
