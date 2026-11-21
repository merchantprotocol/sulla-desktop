// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Web origin that serves private mobile file links (`/f/<id>`) when no Cloud origin override is active. */
export const DEFAULT_MOBILE_FILE_ORIGIN = 'https://sulladesktop.com';

/** The file id shape used by `sulla-file://<id>` references (chat cards, copied references, bookmarks). */
export const DURABLE_FILE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

/**
 * Matches the two chat file-card forms:
 * - `sulla-file://<id>?version&name&path` (Desktop card, opens in Files)
 * - `https://<host>/f/<id>` (private mobile link; same file)
 */
// Read the whole identity token, including malformed path/authority suffixes,
// so a bad reference cannot be shortened into a different, valid file ID.
const CARD_EXPRESSION = /sulla-file:\/\/([^\s?()[\]<>"'`,;]+)(?:\?([^\s)]+))?|https:\/\/([a-zA-Z0-9.-]+(?::\d+)?)\/f\/([a-zA-Z0-9_-]+)/g;

export class DurableFileReferenceParser {
  private readonly allowedMobileHosts: Set<string>;

  /** @param mobileOrigins HTTPS origins whose `/f/<id>` links render as file cards. */
  constructor(mobileOrigins: readonly string[] = [DEFAULT_MOBILE_FILE_ORIGIN]) {
    this.allowedMobileHosts = new Set(mobileOrigins.map(origin => new URL(origin).host));
  }

  parse(content:string):DurableFileReference[] {
    const references:DurableFileReference[] = [];
    for (const match of content.matchAll(CARD_EXPRESSION)) {
      if (match[1]) {
        references.push(this.fromCardLink(match[2] === undefined ? match[1].replace(/[.!]+$/, '') : match[1], match[2] ?? ''));
      } else if (match[3] && match[4] && this.allowedMobileHosts.has(match[3])) {
        references.push(this.fromMobileLink(match[4]));
      }
    }
    return references.filter((item, index) => references.findIndex(other => other.fileId === item.fileId && other.versionId === item.versionId) === index);
  }

  private fromCardLink(fileId:string, query:string):DurableFileReference {
    const params = new URLSearchParams(query);
    const displayPath = params.get('path') ?? params.get('name') ?? fileId;
    return {
      fileId,
      versionId: params.get('version') ?? '',
      path:      displayPath,
      name:      params.get('name') ?? displayPath.split('/').pop() ?? displayPath,
    };
  }

  private fromMobileLink(fileId:string):DurableFileReference {
    // The https link carries only the id; the name is resolved from the descriptor when the file opens.
    return { fileId, versionId: '', path: fileId, name: 'Shared file' };
  }
}

const defaultParser = new DurableFileReferenceParser();

export function parseDurableFileReferences(content:string, mobileOrigins?:readonly string[]):DurableFileReference[] {
  return mobileOrigins ? new DurableFileReferenceParser(mobileOrigins).parse(content) : defaultParser.parse(content);
}
