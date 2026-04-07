# Computer Use Settings — AppleScript App Automation Gateway

## Overview

A dedicated settings window (separate from Preferences) where users grant Sulla permission to control specific macOS applications via AppleScript/AppleEvents. Instead of building individual API integrations for each app, Sulla's agent dynamically generates and executes AppleScript to interact with any scriptable application on the system. This settings window is the user-facing gate that controls which apps Sulla is allowed to automate.

This is distinct from the Computer Use Agent (screenshot + mouse/keyboard control). That system operates visually at the pixel level. This system operates semantically at the application scripting level — faster, more reliable, and purpose-built for structured app interactions like reading calendar events, creating reminders, or sending messages.

## Why

Sulla currently integrates with external services through OAuth-based web APIs (Google Calendar, Notion, etc.). These require per-service integration code, API keys, and network connectivity. Meanwhile, macOS ships with a powerful scripting bridge that lets any entitled app control any other scriptable app — Calendar, Reminders, Mail, Notes, Safari, Finder, Music, Messages, and hundreds of third-party apps — all through a single entitlement.

By giving Sulla the `com.apple.security.automation.apple-events` entitlement and letting the LLM generate AppleScript on the fly, one tool replaces dozens of hardcoded integrations. The LLM already knows AppleScript syntax. The user gets local-first, offline-capable automation of their entire macOS environment.

## Core Concepts

### Single Entitlement, Many Apps

The `com.apple.security.automation.apple-events` entitlement allows Sulla to send AppleEvents to other applications. macOS TCC (Transparency, Consent, and Control) handles the hard security — the first time Sulla tries to script a specific app, macOS prompts the user: "Sulla Desktop wants to control [App]. Allow?" The user can revoke this anytime in System Settings > Privacy & Security > Automation.

### Two Layers of Gating

1. **Sulla's Computer Use Settings** (this feature) — the user opts in to which apps Sulla is allowed to *attempt* to control. If Calendar is toggled off, Sulla's agent will never generate or execute AppleScript targeting Calendar, regardless of macOS permissions.
2. **macOS TCC** (system-level) — even if the user enables an app in Sulla's settings, macOS still prompts for permission on first use and the user can revoke it at the OS level at any time.

This dual-layer approach means the user has granular control both within Sulla and at the system level.

### LLM-Generated Scripts

The agent does not use pre-built scripts. When a user says "add a reminder to buy groceries tomorrow," the LLM generates the appropriate AppleScript:

```applescript
tell application "Reminders"
  set newReminder to make new reminder in list "Reminders"
  set name of newReminder to "Buy groceries"
  set due date of newReminder to (current date) + 1 * days
end tell
```

This means Sulla can handle any action an app exposes through its scripting dictionary, not just actions we anticipated and coded for. New apps, new actions, new workflows — all supported without code changes.

### Read vs Write Safety Classification

Actions are classified as read (safe to auto-execute) or write (requires user confirmation):

- **Read actions** — querying calendar events, listing reminders, reading note titles, checking mailbox counts. These execute automatically and return results to the agent.
- **Write actions** — creating events, sending emails, deleting reminders, posting messages. These show the generated script to the user for approval before execution.

## The Computer Use Settings Window

### Window Design

A standalone Electron window (like Language Model Settings or Audio Settings), not a tab within Preferences. Opened from the main app menu or a button in the chat interface.

The window presents a scrollable list of macOS applications grouped by category. Each entry has:

- **App icon** — pulled from the system or bundled
- **App name** — the human-readable name
- **Enable toggle** — on/off switch
- **Description** — one or two lines explaining what Sulla can do with this app

A "Select All" / "Deselect All" control sits at the top.

### Layout

```
┌──────────────────────────────────────────────────────┐
│  Computer Use Settings                          [X]  │
│                                                      │
│  Control which applications Sulla can interact       │
│  with on your Mac. macOS will also ask for your      │
│  permission the first time Sulla accesses each app.  │
│                                                      │
│  [Select All]  [Deselect All]                        │
│                                                      │
│  ── Productivity ──────────────────────────────────  │
│                                                      │
│  [icon]  Calendar                          [toggle]  │
│          Create events, check your schedule,         │
│          manage invitations and RSVPs                │
│                                                      │
│  [icon]  Reminders                         [toggle]  │
│          Create and complete reminders,              │
│          manage lists and due dates                  │
│                                                      │
│  [icon]  Notes                             [toggle]  │
│          Read, create, and edit notes                │
│          across all your folders                     │
│                                                      │
│  [icon]  Contacts                          [toggle]  │
│          Look up contact details, create             │
│          and update contact records                  │
│                                                      │
│  ── Communication ─────────────────────────────────  │
│                                                      │
│  [icon]  Mail                              [toggle]  │
│          Read, compose, and send emails,             │
│          manage mailboxes and rules                  │
│                                                      │
│  [icon]  Messages                          [toggle]  │
│          Send and read iMessages and SMS             │
│                                                      │
│  [icon]  FaceTime                          [toggle]  │
│          Initiate audio and video calls              │
│                                                      │
│  ── Browsers ──────────────────────────────────────  │
│                                                      │
│  [icon]  Safari                            [toggle]  │
│          Open URLs, read page content,               │
│          manage tabs and bookmarks                   │
│                                                      │
│  [icon]  Google Chrome                     [toggle]  │
│          Open URLs, manage tabs, read                │
│          page content                                │
│                                                      │
│  [icon]  Arc                               [toggle]  │
│          Open URLs, manage tabs and spaces           │
│                                                      │
│  ── Media ─────────────────────────────────────────  │
│                                                      │
│  [icon]  Music                             [toggle]  │
│          Play, pause, skip, queue songs,             │
│          search your library                         │
│                                                      │
│  [icon]  Photos                            [toggle]  │
│          Browse, search, and export photos           │
│                                                      │
│  [icon]  QuickTime Player                  [toggle]  │
│          Open and control media playback             │
│                                                      │
│  ── System ────────────────────────────────────────  │
│                                                      │
│  [icon]  Finder                            [toggle]  │
│          Manage files, open folders, move            │
│          and organize documents                      │
│                                                      │
│  [icon]  System Events                     [toggle]  │
│          Control system-level automation:            │
│          keystrokes, UI elements, processes          │
│                                                      │
│  [icon]  Terminal                           [toggle]  │
│          Run shell commands and scripts              │
│                                                      │
│  [icon]  System Settings                   [toggle]  │
│          Toggle Wi-Fi, Dark Mode, Do Not            │
│          Disturb, and other system prefs             │
│                                                      │
│  ── Third Party ───────────────────────────────────  │
│                                                      │
│  [icon]  Spotify                           [toggle]  │
│          Playback control, queue songs,              │
│          search your library                         │
│                                                      │
│  [icon]  Slack                             [toggle]  │
│          Send messages, set status,                  │
│          manage channels                             │
│                                                      │
│  [icon]  Things                            [toggle]  │
│          Create and manage tasks and                 │
│          projects                                    │
│                                                      │
│  [icon]  OmniFocus                         [toggle]  │
│          Create tasks, manage projects               │
│          and perspectives                            │
│                                                      │
│  [icon]  Fantastical                       [toggle]  │
│          Create events and reminders                 │
│          with natural language                       │
│                                                      │
│  [icon]  Bear                              [toggle]  │
│          Create and search notes with                │
│          tags and markdown                           │
│                                                      │
│  [icon]  iTerm2                            [toggle]  │
│          Run shell commands in iTerm                 │
│          sessions                                    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Installed App Detection

On window open, Sulla checks which of the known apps are actually installed on the system (via `mdfind "kMDItemCFBundleIdentifier == 'com.apple.reminders'"` or checking `/Applications/`). Apps that are not installed are hidden or shown as greyed out with an "Not Installed" label. This keeps the list relevant to the user's actual setup.

### Custom App Support (Future)

A "+ Add Application" button at the bottom allows the user to pick any `.app` from Finder and add it to the list. Sulla can attempt to script any app — if the app has a scripting dictionary, it will work. This covers niche apps we did not pre-configure.

## Agent Tool — AppleScript Execution

### Tool Definition

The agent receives a single tool for macOS app automation:

```json
{
  "name": "applescript_execute",
  "description": "Execute AppleScript to interact with macOS applications. Use this to read data from or perform actions in apps the user has enabled in Computer Use Settings. Always specify the target app. For write operations (creating, sending, deleting), the user will be asked to confirm before execution.",
  "parameters": {
    "target_app": {
      "type": "string",
      "description": "The macOS application to control (e.g. 'Calendar', 'Reminders', 'Mail')"
    },
    "script": {
      "type": "string",
      "description": "The AppleScript code to execute"
    },
    "action_type": {
      "type": "string",
      "enum": ["read", "write"],
      "description": "Whether this action reads data or modifies/creates data"
    }
  }
}
```

### Execution Flow

```
Agent generates tool call
        │
        ▼
Is target_app enabled in Computer Use Settings?
        │
   NO ──┤── Return error: "Calendar is not enabled in Computer Use Settings.
        │    Ask the user to enable it."
   YES ─┤
        ▼
Is action_type "write"?
        │
   YES ─┤── Show confirmation dialog to user:
        │   "Sulla wants to create a reminder: 'Buy groceries'
        │    due tomorrow. Allow?"
        │        │
        │   DENY ── Return: "User declined this action."
        │   ALLOW ─┤
   NO ──┤          │
        ▼          ▼
Execute: osascript -e '<script>'
        │
        ▼
Return stdout to agent (or error message if failed)
```

### Script Execution

```typescript
import { execFile } from 'child_process';

async function executeAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], {
      timeout: 10000, // 10 second timeout
      maxBuffer: 1024 * 1024, // 1MB output limit
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`AppleScript error: ${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
```

### JXA Alternative

For complex operations, JavaScript for Automation (JXA) may be preferable to AppleScript. The same `osascript` binary supports it:

```typescript
execFile('osascript', ['-l', 'JavaScript', '-e', jxaScript]);
```

The agent can choose whichever scripting language is more appropriate for the task. JXA has better JSON handling and is more natural for the LLM to generate when structured data is involved.

## Persistence

### Settings Storage

Enabled apps are stored via `SullaSettingsModel`, consistent with other Sulla settings:

```typescript
interface ComputerUseSettings {
  enabledApps: Record<string, boolean>;
}

// Example stored state
{
  "enabledApps": {
    "com.apple.iCal": true,
    "com.apple.reminders": true,
    "com.apple.Notes": false,
    "com.apple.mail": false,
    "com.apple.Safari": true,
    "com.spotify.client": true
  }
}
```

Apps are keyed by bundle identifier for uniqueness. The UI maps bundle IDs to display names.

### App Registry

A static registry defines the known apps, their metadata, and categories:

```typescript
interface AppEntry {
  bundleId: string;
  name: string;
  description: string;
  category: 'productivity' | 'communication' | 'browsers' | 'media' | 'system' | 'third-party';
  icon?: string; // bundled icon path, or resolved from system at runtime
  defaultEnabled: boolean;
}

const APP_REGISTRY: AppEntry[] = [
  {
    bundleId: 'com.apple.iCal',
    name: 'Calendar',
    description: 'Create events, check your schedule, manage invitations and RSVPs',
    category: 'productivity',
    defaultEnabled: false,
  },
  // ...
];
```

## Entitlement and Info.plist Changes

### Entitlement

Add to the main app entry in `build/signing-config-mac.yaml`:

```yaml
- com.apple.security.automation.apple-events
```

### Info.plist

Add via electron-builder `extendInfo` in `packaging/electron-builder.yml`:

```yaml
extendInfo:
  NSAppleEventsUsageDescription: "Sulla uses automation to interact with apps on your Mac — like managing your calendar, creating reminders, or controlling music playback. You choose which apps to enable."
```

### Contacts (Direct API)

For Contacts specifically, the AppleScript dictionary is limited. If deep Contacts integration is desired, add:

- Entitlement: `com.apple.security.personal-information.contacts`
- Info.plist: `NSContactsUsageDescription: "Sulla accesses your contacts to look up people, create new contacts, and keep your address book up to date."`
- Implementation: Swift helper script using `CNContactStore` (same pattern as existing audio driver Swift helpers in `resources/darwin/`)

This is optional and can be added in a later phase.

## Safety and Guardrails

### Write Confirmation Dialog

Any action classified as `write` shows a native Electron dialog before execution:

```
┌─────────────────────────────────────────┐
│  Sulla wants to control Reminders       │
│                                         │
│  Action: Create a new reminder          │
│                                         │
│  tell application "Reminders"           │
│    make new reminder in list            │
│    "Reminders" with properties          │
│    {name: "Buy groceries",             │
│     due date: date "2026-04-08"}       │
│  end tell                               │
│                                         │
│  [Always Allow]  [Allow Once]  [Deny]   │
└─────────────────────────────────────────┘
```

"Always Allow" could auto-approve future write actions for that specific app (stored in settings). "Allow Once" executes this one action. "Deny" blocks it.

### Script Sanitization

Before execution, validate:

- The script targets only the declared `target_app` (parse for `tell application "X"` blocks)
- No `do shell script` commands embedded in the AppleScript (prevents shell escape)
- No `tell application "System Events"` unless System Events is explicitly enabled
- Script length does not exceed a reasonable limit (e.g., 10KB)
- Timeout enforcement (10 seconds default, configurable)

### Audit Log

Every execution is logged:

```typescript
interface AppleScriptLogEntry {
  timestamp: string;
  targetApp: string;
  actionType: 'read' | 'write';
  script: string;
  result: string | null;
  error: string | null;
  userApproved: boolean; // for write actions
}
```

Logs are viewable in the Computer Use Settings window under a "History" tab.

## Implementation Phases

### Phase 1 — Entitlement + Agent Tool

- Add `com.apple.security.automation.apple-events` entitlement to signing config
- Add `NSAppleEventsUsageDescription` to Info.plist via electron-builder
- Create the `applescript_execute` agent tool with basic execution
- Hardcode a small set of enabled apps for testing (Calendar, Reminders, Notes)
- Verify macOS TCC prompts appear correctly on first use per app

### Phase 2 — Computer Use Settings Window

- Create the Electron BrowserWindow (standalone, not in Preferences)
- Build the app list UI with categories, toggles, icons, and descriptions
- Implement the app registry with all known apps
- Wire up persistence via SullaSettingsModel
- Add installed-app detection to show only relevant apps
- Add menu item / button to open the settings window

### Phase 3 — Safety Layer

- Implement read/write classification in the tool handler
- Build the write confirmation dialog
- Add script sanitization (no shell escape, single target app)
- Add timeout enforcement
- Add audit logging

### Phase 4 — Polish

- "Always Allow" per-app write auto-approval
- History tab showing recent AppleScript executions
- Custom app support ("+ Add Application")
- JXA support for complex structured-data operations
- App icon resolution from system at runtime
- Keyboard shortcut to open Computer Use Settings

## File Structure (Proposed)

```
pkg/rancher-desktop/
  main/
    computerUseSettings/
      computerUseSettingsWindow.ts   — Electron BrowserWindow manager
      appRegistry.ts                 — Static registry of known scriptable apps
      installedAppDetector.ts        — Check which registered apps are installed
  agent/
    tools/
      applescript/
        index.ts                     — Tool definition and execution handler
        sanitizer.ts                 — Script validation and sanitization
        confirmationDialog.ts        — Write-action approval dialog
        auditLog.ts                  — Execution history logging
  pages/
    ComputerUseSettings.vue          — Main settings page component
  components/
    ComputerUseSettings/
      AppList.vue                    — Scrollable categorized app list
      AppEntry.vue                   — Single app row (icon, name, toggle, desc)
      CategoryHeader.vue             — Category section divider
      HistoryTab.vue                 — Audit log viewer
  window/
    computerUseSettings.ts           — Window open/close, IPC registration
  store/
    computerUseSettings.ts           — Vuex module for enabled apps state
build/
  signing-config-mac.yaml            — Add apple-events entitlement
packaging/
  electron-builder.yml               — Add NSAppleEventsUsageDescription
```

## Relationship to Existing Systems

- **Computer Use Agent** (`computer-use-agent.md`): Complementary, not overlapping. The Computer Use Agent controls the mouse and keyboard via screenshots and CGEvent — it operates visually. This system operates semantically through application scripting. The agent should prefer AppleScript when an app is scriptable and enabled, falling back to visual computer use for apps that are not scriptable or for UI interactions that have no scripting equivalent.
- **Native Productivity Integrations** (`agent/integrations/native/productivity.ts`): The existing OAuth-based integrations (Google Calendar, Notion, etc.) remain useful for cloud-synced data and cross-platform support. AppleScript automation complements these by providing local-first, offline-capable access to the same data through the native macOS apps.
- **Audio Driver Swift Helpers** (`resources/darwin/audio-driver/*.swift`): Establishes the pattern for executing Swift code from the main process. The same pattern can be used for Contacts (CNContactStore) if direct framework access is needed beyond what AppleScript provides.
- **Agent Tool Schema**: The `applescript_execute` tool plugs into the existing agent tool system alongside file editing, terminal, browser, and other tools. The agent chooses the right tool based on the user's request and what is available.
