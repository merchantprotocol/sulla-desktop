export type ChatArtifactKind = 'markdown' | 'html' | 'code';
export type ChatArtifactStatus = 'working' | 'done' | 'error' | 'viewing' | 'editing';
export type ChatArtifactAuthor = 'agent' | 'human';

export interface ChatArtifactRecord {
  id:        string;
  threadId:  string;
  name:      string;
  kind:      ChatArtifactKind;
  content:   string;
  status:    ChatArtifactStatus;
  isOpen:    boolean;
  isDeleted: boolean;
  version:   number;
  language?: string | null;
  path?:     string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatArtifactRevision {
  artifactId: string;
  version:    number;
  content:    string;
  author:     ChatArtifactAuthor;
  createdAt:  string;
}

export interface ChatArtifactChangedEvent {
  threadId: string;
  artifact: ChatArtifactRecord;
  focus?:   boolean;
}
