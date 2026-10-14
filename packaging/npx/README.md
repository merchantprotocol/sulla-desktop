# sulla-desktop

Download and launch [Sulla Desktop](https://sulladesktop.com) with one command:

```bash
npx sulla-desktop
```

That's it. The first run downloads the latest release for your computer, checks it, installs it and opens it. After that, the same command just opens Sulla (and tells you when there's an update).

Needs [Node.js](https://nodejs.org) 18 or newer. Works on macOS (Apple Silicon and Intel), Linux (x64) and Windows.

## Options

| Command | What it does |
| --- | --- |
| `npx sulla-desktop` | Install on the first run, open Sulla after that |
| `npx sulla-desktop --update` | Update to the latest release, then open it |
| `npx sulla-desktop --version v1.6.1` | Install a specific release |
| `npx sulla-desktop --no-launch` | Install or update without opening the app |
| `npx sulla-desktop --dry-run` | Show what would be downloaded and where, change nothing |
| `npx sulla-desktop --help` | Show help |

## Where it installs

No `sudo` and no admin prompt. It installs where your user account can write:

- **macOS:** `~/Applications/Sulla Desktop.app`. If Sulla already lives in `/Applications`, it updates that copy.
- **Linux:** `~/.local/share/sulla-desktop`, with a `sulla-desktop` command in `~/.local/bin` and an app-menu entry.
- **Windows:** `%LOCALAPPDATA%\Programs\Sulla Desktop`

## Safe by default

- Downloads come only from the official [GitHub releases](https://github.com/merchantprotocol/sulla-desktop/releases).
- Every download is checked against the sha256 digest GitHub publishes for that file. If it doesn't match, nothing is installed.
- If Sulla is running, it's never replaced or closed. You'll see "update available"; quit Sulla and run `npx sulla-desktop --update`.
- The new version is unpacked next to the old one and swapped in at the end, so a failed download never leaves you with a broken app.

Hitting GitHub's rate limit on a shared network? Set `GITHUB_TOKEN` and run it again.

## Other ways to install

```bash
curl -fsSL https://sulladesktop.com/install.sh | sh
```

Or grab an installer from the [latest release](https://github.com/merchantprotocol/sulla-desktop/releases/latest).

MIT licensed. Sulla Desktop itself is licensed separately; see the [main repository](https://github.com/merchantprotocol/sulla-desktop).
