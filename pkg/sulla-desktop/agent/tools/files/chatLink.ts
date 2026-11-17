// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export function fileChatLink(file: any): string | undefined {
  const id = file?.fileId ?? file?.file_id ?? file?.id;
  const path = file?.path;
  if (!id || !path) return undefined;
  if (file?.kind === 'folder' || file?.type === 'folder' || file?.isFolder === true) return undefined;
  return `https://sulladesktop.com/f/${ encodeURIComponent(String(id)) }`;
}

export function addChatLinks(value: any): any {
  if (Array.isArray(value)) return value.map(addChatLinks);
  if (!value || typeof value !== 'object') return value;
  const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, addChatLinks(item)]));
  const chatLink = fileChatLink(value);
  return chatLink ? { ...mapped, chatLink } : mapped;
}
