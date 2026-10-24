# macOS native CI signing setup

The macOS native workflow always builds the native components unsigned. Pull requests, including pull requests from forks, never receive signing credentials. A separate signed job runs only for a push to `main` or a manual `workflow_dispatch`, and GitHub must release its credentials through the protected `macos-signing` environment.

## Protect the signing environment

In GitHub, open **Settings → Environments**, create an environment named **`macos-signing`**, and configure it before adding credentials:

1. Set **Required reviewers** to **`jonathonbyrdziak`**. Jonathon must approve every signed run before GitHub releases any signing secret.
2. Set **Deployment branches and tags** to **Selected branches and tags**, then allow **`main` only**.
3. Turn **Allow administrators to bypass configured protection rules** off.
4. Add the four values below as **environment secrets**, not repository or organization secrets.

The workflow has top-level `contents: read` permissions and checks out without persisted credentials. It never uses `pull_request_target`; pull-request builds are unsigned. The signed job uses only SHA-pinned `actions/checkout` and `actions/upload-artifact` actions. It deletes its temporary keychain, certificate file, and profiles even after a failure, and it uploads only the signed `.appex` bundles for seven days.

Also enable GitHub's organization or repository policy that requires 2FA, and protect `main` with required pull-request review. Those controls make it harder for a compromised collaborator token to change this public workflow and then request a signed run.

## Environment secrets

Create these under **Settings → Environments → macos-signing → Environment secrets**:

| Secret | Contents |
| --- | --- |
| `MACOS_DEVELOPER_ID_P12_BASE64` | Base64 text of a password-protected export of the Developer ID Application identity. |
| `MACOS_DEVELOPER_ID_P12_PASSWORD` | The password chosen while exporting that `.p12`. |
| `MACOS_PROFILE_APP_BASE64` | Base64 text of `Sulla_Desktop_Developer_ID.provisionprofile`. |
| `MACOS_PROFILE_FILE_PROVIDER_BASE64` | Base64 text of `Sulla_Desktop_File_Provider_Developer_ID.provisionprofile`. |

Do this yourself on the Mac. No agent should read, copy, export, print, or move the private key or `.p12` file.

### Developer ID certificate

1. Open **Keychain Access**.
2. Find **Developer ID Application: JONATHON CALEB BYRDZIAK (946AF7TL74)** under **My Certificates**.
3. Export that identity as a `.p12` and give the export a strong, unique password. Keep the file local and delete it securely after the environment secret is confirmed.
4. In Terminal, copy only its base64 encoding to the clipboard:

   ```bash
   base64 -i /path/to/exported-developer-id.p12 | pbcopy
   ```

5. Paste it into `MACOS_DEVELOPER_ID_P12_BASE64`, then add the export password separately as `MACOS_DEVELOPER_ID_P12_PASSWORD`.

### Provisioning profiles

Copy each profile's base64 encoding directly to the clipboard, then paste it into the matching GitHub environment secret:

```bash
base64 -i ~/sulla/signing/Sulla_Desktop_Developer_ID.provisionprofile | pbcopy
```

Paste that value into `MACOS_PROFILE_APP_BASE64`.

```bash
base64 -i ~/sulla/signing/Sulla_Desktop_File_Provider_Developer_ID.provisionprofile | pbcopy
```

Paste that value into `MACOS_PROFILE_FILE_PROVIDER_BASE64`.

The profiles are configuration assets, but keep them in the protected environment with the certificate so the signed job has one deliberately gated credential boundary. Never commit certificates, profiles, their base64 encodings, or passwords.

## Notarization later

Notarization is intentionally disabled. An Apple-ID setup would require environment secrets `APPLE_ID` and `APPLE_APP_PASSWORD`, plus `APPLE_TEAM_ID` set to `946AF7TL74`, and would submit an archive with:

```bash
xcrun notarytool submit "$ARCHIVE" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
```

An App Store Connect API key can be used instead. Do not add either notarization path until the packaging flow produces the archive that Apple should notarize.
