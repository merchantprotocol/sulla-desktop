export interface DurableFileReference {
  fileId:string;
  versionId:string;
  path:string;
  name:string;
  mime?:string;
  size?:number;
  createdByType?:string;
  createdById?:string;
  collectionId?:string;
  collectionKind?:string;
  agentRunId?:string;
}

export function parseDurableFileReferences(content:string):DurableFileReference[] {
  const references:DurableFileReference[] = [];
  const expression = /sulla-file:\/\/([a-zA-Z0-9_-]+)(?:\?([^\s)]+))?/g;
  for (const match of content.matchAll(expression)) {
    const params = new URLSearchParams(match[2] ?? '');
    const displayPath = params.get('path') ?? params.get('name') ?? match[1];
    references.push({
      fileId:    match[1],
      versionId: params.get('version') ?? '',
      path:      displayPath,
      name:      params.get('name') ?? displayPath.split('/').pop() ?? displayPath,
    });
  }
  return references.filter((item, index) => references.findIndex(other => other.fileId === item.fileId && other.versionId === item.versionId) === index);
}
