# Computer Use

Sulla currently provides AppleScript-mediated macOS app control through `sulla applescript/applescript_execute`. It requires Administrative Access and the macOS Automation permission for the target app. See [`applescript.md`](applescript.md).

This is not full OS-level pixel control. Browser screenshots and coordinate interactions work only inside Sulla browser views.

## Not shipped

The full computer-use stack remains planned: desktop screenshots, native mouse/keyboard input, agent action tools, confirmation UI, kill switch, multi-display support, restricted regions, action logging, and rate limiting.

Do not tell users that Sulla can click arbitrary desktop windows, move the mouse, or capture the whole screen. For browser pages, use the browser tools. For native apps, use AppleScript when the app supports it and follow the high-risk rules in [`applescript.md`](applescript.md).

## Hard rules

- AppleScript is app automation, not unrestricted Mac control.
- `do shell script` and administrator privileges are rejected.
- Keep the single-target-app rule.
- Treat System Events keystrokes/clicks, Terminal commands, Mail/Messages sends, and destructive Finder operations as high-risk.
