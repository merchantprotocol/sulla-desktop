# Releasing Sulla Desktop

Release zips are about 2.9 GB each, over GitHub's 2 GiB limit per release
asset. So the zips and the update feed live in the Cloudflare R2 bucket
`sulla-desktop-releases`, served publicly at **https://releases.sulladesktop.com**.
GitHub Releases still carry the tag and the release notes, but no zips.

## Bucket layout

| Key | Cache-Control | What |
|---|---|---|
| `releases/v<version>/Sulla-Desktop-<version>-<arch>-mac.zip` | `public, max-age=31536000, immutable` | Signed, notarized app zip. `<arch>` is `x64` or `arm64`. |
| `releases/v<version>/Sulla-Desktop-<version>-<arch>-mac.zip.blockmap` | immutable | Block map for electron-updater's differential download. |
| `releases/v<version>/latest.json` | `public, max-age=300` | Manifest for this version (see below). |
| `releases/v<version>/latest-mac.yml` | `public, max-age=300` | electron-updater feed for this version, without release notes. |
| `channels/latest/latest.json` | `no-cache` | Manifest of the current release. The website and installers read this. |
| `channels/latest/latest-mac.yml` | `no-cache` | The update feed the app reads. |

A versioned zip URL never changes content. The upload refuses to overwrite one
with different bytes (it compares sha512 first), so to fix a bad build, bump the
version. The big zips are never copied: the channel files point at the
versioned zips with absolute URLs.

`latest.json`:

```json
{
  "schema": 1,
  "version": "1.7.0",
  "tag": "v1.7.0",
  "releaseDate": "2026-10-26T12:00:00.000Z",
  "notesUrl": "https://github.com/merchantprotocol/sulla-desktop/releases/tag/v1.7.0",
  "files": {
    "x64":   { "name": "Sulla-Desktop-1.7.0-x64-mac.zip",   "url": "https://releases.sulladesktop.com/releases/v1.7.0/Sulla-Desktop-1.7.0-x64-mac.zip",   "size": 0, "sha512": "<base64>", "sha256": "<hex>" },
    "arm64": { "name": "Sulla-Desktop-1.7.0-arm64-mac.zip", "url": "https://releases.sulladesktop.com/releases/v1.7.0/Sulla-Desktop-1.7.0-arm64-mac.zip", "size": 0, "sha512": "<base64>", "sha256": "<hex>" }
  }
}
```

For a stable "download the latest" link, read
`https://releases.sulladesktop.com/channels/latest/latest.json` and use
`files.arm64.url` (Apple Silicon) or `files.x64.url` (Intel).

## How a release goes out

1. **Tag.** Push a `v<version>` tag. The Package workflow
   (`.github/workflows/package.yaml`) builds, signs, notarizes and verifies one
   zip per architecture, exactly as before.
2. **Upload.** Its `release` job uploads every zip and block map to
   `releases/v<version>/` with `scripts/release/publish-to-releases.mjs`, then
   hashes the zips, checks each one is publicly reachable with the right size,
   and uploads `releases/v<version>/latest.json` and `latest-mac.yml`.
3. **Draft.** It creates a draft GitHub Release with generated notes and
   download links. No zips are attached.
4. **Publish.** Publishing the draft runs the Update feed workflow
   (`.github/workflows/update-feed.yaml`). It reads
   `releases/v<version>/latest.json`, checks every zip again, adds the GitHub
   release notes, refuses to replace a newer version, and writes
   `channels/latest/latest.json` and then `channels/latest/latest-mac.yml`.
   The feed goes last, so the app never sees a feed that points at a missing
   file. Prereleases are not promoted.

Until step 4, nothing users see changes. Installed apps pick the new version up
on their next check (every 6 hours, or **Check for updates**).

### By hand

Run **Update feed** from the Actions tab with a `tag`:

- `rehash` (default on) downloads the zips from `RELEASES_BASE_URL`, recomputes
  sizes and checksums, and rewrites `releases/v<version>/latest.json` and
  `latest-mac.yml` before promoting. Use it if the manifest is missing or wrong.
- `allow_older` lets you promote an older version, to roll back the channel.
  The app never downgrades itself; this only changes what new installs and the
  website get, and stops further updates to the newer version.

### Running the scripts locally

```bash
# Unit and end-to-end tests (no network, no dependencies)
node --test 'scripts/release/test/*.test.mjs'

# Upload one file (needs the uploader URL and token in the environment)
RELEASES_UPLOAD_URL=... RELEASES_UPLOAD_TOKEN=... \
  node scripts/release/publish-to-releases.mjs <file> <key> \
    [--cache-control <value>] [--content-type <type>] [--skip-if-identical-at <public url>]

# Manifest and feed
node scripts/release/release-feed.mjs manifest --version 1.7.0 --base-url https://releases.sulladesktop.com --out latest.json Sulla-Desktop-1.7.0-*-mac.zip
node scripts/release/release-feed.mjs feed --manifest latest.json --out-dir out [--notes-file notes.md]
node scripts/release/release-feed.mjs verify --manifest latest.json
```

`publish-to-releases.mjs` sends files over 64 MiB as a multipart upload in
equal 64 MiB parts, three at a time, and smaller ones in one request. It retries
network errors, 429 and 5xx with exponential backoff, aborts a multipart upload
that fails for good, and checks the stored size equals the local size. It never
prints the token.

## Required configuration

| Name | Kind | Value |
|---|---|---|
| `RELEASES_UPLOAD_TOKEN` | secret | Bearer token of the uploader Worker |
| `RELEASES_UPLOAD_URL` | variable | URL of the uploader Worker |
| `RELEASES_BASE_URL` | variable | `https://releases.sulladesktop.com` |

Both workflows stop with a clear error if any of them is missing. The uploader
Worker, its deployment and token rotation are described in
[`infra/release-uploader/README.md`](../infra/release-uploader/README.md). It
can only write under `releases/` and `channels/`; it cannot read, list or
delete.

The signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) are unchanged.

## How the app finds updates

`packaging/electron-builder.yml` has a `publish` block with electron-updater's
generic provider and `url: https://releases.sulladesktop.com/channels/latest`.
electron-builder writes it into the app as `app-update.yml` (it never uploads
anything itself). That is the only place the feed location is set for packaged
builds; `dev-app-update.yml` repeats it for `yarn dev`.

electron-updater fetches `<url>/latest-mac.yml`, picks the `arm64` or `x64`
entry by the `arm64` in its URL, and downloads the zip from its absolute URL.
When the previous update's zip is cached it first tries a differential download
using the `.blockmap` files, and falls back to the full zip if that fails. The
in-app "is there an update" check (`main/update/lightweightCheck.ts`) reads the
same `latest-mac.yml`.

Apps released before this change read updates from GitHub Releases and can't
follow the feed to R2. Their users need to download the new version once; from
then on updates come from the bucket.
