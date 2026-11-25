// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { appendFileSync } from 'node:fs';

export interface ConversationEventAppender {
  append(filePath: string, contents: string): void;
}

export class FileConversationEventAppender implements ConversationEventAppender {
  append(filePath: string, contents: string): void { appendFileSync(filePath, contents, 'utf-8') }
}
