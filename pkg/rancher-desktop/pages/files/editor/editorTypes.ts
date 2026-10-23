// Kept free of editor components so the File Manager (also bundled into the Files web UI) can ask
// "does this open in the document editor?" without pulling CodeMirror into that bundle.
export const documentEditorExtensions = { markdown: ['.sulla.md', '.md'], text: ['.txt'] } as const;

export type DocumentEditorTypeId = keyof typeof documentEditorExtensions;

export function documentEditorTypeIdForPath(path:string):DocumentEditorTypeId | undefined {
  const normalized = path.toLowerCase();
  return (Object.keys(documentEditorExtensions) as DocumentEditorTypeId[]).find(id => documentEditorExtensions[id].some(extension => normalized.endsWith(extension)));
}

export function supportsDocumentEditor(path:string):boolean { return Boolean(documentEditorTypeIdForPath(path)) }
