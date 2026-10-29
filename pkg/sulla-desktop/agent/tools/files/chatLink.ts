// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export function fileChatLink(file: any): string | undefined {
  const id = file?.fileId ?? file?.file_id ?? file?.id;
  const path = file?.path;
  if (!id || !path) return undefined;
  if (file?.kind === 'folder' || file?.type === 'folder' || file?.isFolder === true) return undefined;
  const version = file?.versionId ?? file?.version_id ?? file?.current_version_id ?? file?.version?.id;
  const name = file?.name ?? String(path).split('/').pop() ?? String(path);
  const params = new URLSearchParams({ ...(version ? { version: String(version) } : {}), name: String(name), path: String(path) });
  return `sulla-file://${ encodeURIComponent(String(id)) }?${ params }`;
}

export function addChatLinks(value: any): any {
  if (Array.isArray(value)) return value.map(addChatLinks);
  if (!value || typeof value !== 'object') return value;
  const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, addChatLinks(item)]));
  const chatLink = fileChatLink(value);
  return chatLink ? { ...mapped, chatLink } : mapped;
}
