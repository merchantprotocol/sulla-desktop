// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as Automerge from '@automerge/automerge';

export type TextDocument = { text:string };

export function utf8Text(bytes:Buffer):string | undefined {
  try {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return text.includes('\0') ? undefined : text;
  } catch { return undefined }
}

export function newTextDocument(text:string):Automerge.Doc<TextDocument> { return Automerge.from<TextDocument>({text}) }
export function editTextDocument(document:Automerge.Doc<TextDocument>,text:string):Automerge.Doc<TextDocument> {
  return Automerge.change(document,draft=>Automerge.updateText(draft,['text'],text));
}
export function mergeTextDocuments(baseText:string,currentText:string,submittedText:string) {
  const base=newTextDocument(baseText);
  return Automerge.merge(editTextDocument(Automerge.clone(base),currentText),editTextDocument(Automerge.clone(base),submittedText));
}
export const saveTextDocument=(document:Automerge.Doc<TextDocument>)=>Buffer.from(Automerge.save(document));
export const loadTextDocument=(bytes:Buffer)=>Automerge.load<TextDocument>(bytes);
export const textDocumentHeads=(document:Automerge.Doc<TextDocument>)=>Automerge.getHeads(document);

export type VersionCheckedTextSave =
  | { status:200; merged:boolean; document:Automerge.Doc<TextDocument>; content:string }
  | { status:409; currentVersionId:string };

export function versionCheckedTextSave(input:{baseVersionId:string;currentVersionId:string;base:Buffer;current:Buffer;submitted:Buffer}):VersionCheckedTextSave {
  const base=utf8Text(input.base),current=utf8Text(input.current),submitted=utf8Text(input.submitted);
  if(base===undefined||current===undefined||submitted===undefined){
    if(input.baseVersionId!==input.currentVersionId)return{status:409,currentVersionId:input.currentVersionId};
    const content=input.submitted.toString('utf8');
    return{status:200,merged:false,document:newTextDocument(content),content};
  }
  const merged=input.baseVersionId!==input.currentVersionId;
  const document=merged?mergeTextDocuments(base,current,submitted):editTextDocument(newTextDocument(current),submitted);
  return{status:200,merged,document,content:document.text};
}
