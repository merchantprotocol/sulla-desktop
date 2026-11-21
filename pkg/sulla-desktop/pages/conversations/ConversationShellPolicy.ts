// SPDX-License-Identifier: GPL-2.0-or-later

/** Navigation decisions for the full-screen Conversations shell. */
export class ConversationShellPolicy {
  showsDesktopRail(activeMode: string | undefined): boolean {
    return activeMode !== 'conversations';
  }

  exit(hasPreviousLocation: boolean, goBack: () => void, openDefaultChat: () => void): void {
    if (hasPreviousLocation) goBack();
    else openDefaultChat();
  }
}
